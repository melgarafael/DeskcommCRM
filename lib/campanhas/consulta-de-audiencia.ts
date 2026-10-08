/**
 * O recorte virando linhas — a única peça do módulo de audiência que fala com o
 * banco.
 *
 * Fica separada de `audiencia.ts` (que é o filtro, puro) porque a prévia e o
 * snapshot chamam AS DUAS, e é o par que garante que os dois caminhos vejam o
 * mesmo recorte. Se um dia a prévia e o envio divergirem, a divergência estará
 * aqui, num arquivo só.
 *
 * `organization_id` entra em TODA consulta, explicitamente: o client admin
 * ignora RLS, e é ele que este módulo recebe (a prévia roda numa rota com papel
 * conferido; o snapshot roda no worker, que não tem usuário).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { CAMPANHAS_VIVAS, limiteDeSilencio, usaNegocio, type FiltroDeAudiencia } from "./audiencia";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import { recusouMarketing, type CandidatoDaAudiencia } from "./elegibilidade";
import { camposUsadosNoTexto, type CamposPersonalizados } from "./renderizador";
import { buscaEmLotes } from "@/lib/supabase/em-lotes";

/**
 * O teto de linhas por resposta do PostgREST (`max_rows` em `supabase/config.toml`).
 *
 * É a página dos DOIS caminhos: os negócios de `{{lead.x}}` e a consulta de
 * contatos sem recorte de negócio (que pagina até juntar `filtro.limite`).
 */
const PAGINA_DO_POSTGREST = 1000;

/** Teto de ids que um filtro de negócio devolve antes de virar `in (...)`. */
const TETO_DE_IDS_DE_NEGOCIO = 20_000;

/** Cursor de keyset: a última linha LIDA — não a última guardada (a exclusão é depois). */
interface CursorDeLeitura {
  created_at: string;
  id: string;
}

/**
 * O filtro `.or()` do PostgREST para "depois (ou antes) deste cursor", na ordem
 * (`created_at`, `id`) — o mesmo desenho de `lib/agenda/protecao-followup.ts` e
 * dos cursores de `app/api/v1/campaigns/[id]/recipients`.
 */
function filtroDepoisDoCursor(cursor: CursorDeLeitura, ordem: "asc" | "desc"): string {
  const op = ordem === "asc" ? "gt" : "lt";
  return `created_at.${op}.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.${op}.${cursor.id})`;
}

/**
 * O cursor AVANÇOU? Se não, a página repetiu linhas e a leitura entraria em
 * laço — melhor falhar alto que servir audiência duplicada em silêncio.
 * (Molde: `agenda_page_did_not_advance`.)
 */
function avancou(anterior: CursorDeLeitura, novo: CursorDeLeitura, ordem: "asc" | "desc"): boolean {
  const passo = ordinal(novo.created_at, anterior.created_at) || ordinal(novo.id, anterior.id);
  return ordem === "asc" ? passo > 0 : passo < 0;
}

interface LinhaDeContato {
  id: string;
  /** Carimbado porque a ordem GLOBAL do recorte é (`created_at`, `id`). */
  created_at: string;
  name: string | null;
  display_name: string | null;
  phone_number: string | null;
  is_blocked: boolean;
  is_personal: boolean;
  is_anonymized: boolean;
  consent: unknown;
  /** Só quando o texto pede `{{contato.x}}` — ver `colunasDeContato`. */
  custom_fields?: unknown;
}

/** As colunas de sempre, mais os campos personalizados quando o TEXTO os usa. */
const COLUNAS_DO_CONTATO = "id, name, display_name, phone_number, is_blocked, is_personal, is_anonymized, consent";

/**
 * Os candidatos do recorte, e o recibo de truncamento.
 *
 * `truncado` só é verdadeiro quando o recorte bate o teto de
 * `TETO_DE_IDS_DE_NEGOCIO` E há pelo menos uma linha além dele — a prévia
 * avisa o operador em vez de cortar calada (#2404).
 */
export async function buscarCandidatos(
  admin: SupabaseClient,
  entrada: { organizationId: string; filtro: FiltroDeAudiencia; agora: Date; corpo?: string },
): Promise<{ candidatos: CandidatoDaAudiencia[]; truncado: boolean }> {
  const { organizationId, filtro, agora } = entrada;
  // O corpo entra SÓ para decidir se as colunas de campo personalizado valem a
  // consulta: texto de `{{nome}}` não puxa jsonb de 5.000 linhas em toda prévia.
  const camposDoTexto = camposUsadosNoTexto(entrada.corpo ?? "");
  const colunasDeContato = camposDoTexto.contato ? ", custom_fields" : "";

  // ─── Os contatos que têm negócio no recorte ───
  // Consulta separada, e não `join` embutido do PostgREST: o mesmo contato tem N
  // negócios, e o embed devolveria o contato N vezes — contagem de prévia
  // inflada, que é exatamente o número que o operador confere antes de apertar.
  let idsPorNegocio: string[] | null = null;
  let truncado = false;
  if (usaNegocio(filtro)) {
    // A consulta pede até `TETO_DE_IDS_DE_NEGOCIO` LINHAS e o PostgREST corta
    // TODA resposta em `max_rows` (cuja config da instalação pode ser MENOR que
    // `PAGINA_DO_POSTGREST`). Paginar por `range` tinha dois defeitos: parar
    // cedo quando o `max_rows` era menor (a primeira página já volta "curta") e
    // repetir/perder linha quando um negócio muda de etapa no meio da leitura
    // (#2404). Por isso o laço é KEYSEET em (`created_at`, `id`), e só a página
    // VAZIA prova o fim.
    const consultaDeNegocios = () => {
      let consulta = admin
        .from("crm_leads")
        .select("contact_id, created_at, id")
        .eq("organization_id", organizationId)
        .not("contact_id", "is", null)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true });
      if (filtro.funis.length > 0) consulta = consulta.in("pipeline_id", filtro.funis);
      if (filtro.etapas.length > 0) consulta = consulta.in("stage_id", filtro.etapas);
      if (filtro.responsaveis.length > 0) consulta = consulta.in("owner_user_id", filtro.responsaveis);
      if (filtro.situacoes_do_negocio.length > 0) {
        consulta = consulta.in("status", filtro.situacoes_do_negocio);
      }
      return consulta;
    };
    const linhasDeNegocio: Array<{ contact_id: string; created_at: string; id: string }> = [];
    let cursor: CursorDeLeitura | null = null;
    for (;;) {
      let pagina = consultaDeNegocios().limit(PAGINA_DO_POSTGREST);
      if (cursor) pagina = pagina.or(filtroDepoisDoCursor(cursor, "asc"));
      const { data, error } = await pagina;
      if (error) throw new Error(`audiência: negócios — ${error.message}`);
      const lidas = (data ?? []) as unknown as typeof linhasDeNegocio;
      if (lidas.length === 0) break;
      const ultima = lidas[lidas.length - 1]!;
      const novo = { created_at: ultima.created_at, id: ultima.id };
      if (cursor && !avancou(cursor, novo, "asc")) {
        throw new Error("audiência: audiencia_page_did_not_advance");
      }
      cursor = novo;
      linhasDeNegocio.push(...lidas);
      if (linhasDeNegocio.length >= TETO_DE_IDS_DE_NEGOCIO) {
        // O teto é por LINHA: corta o excesso da última página e sonda UMA
        // linha além do teto — o aviso da prévia não pode mentir num recorte
        // de exatamente 20.000.
        linhasDeNegocio.length = TETO_DE_IDS_DE_NEGOCIO;
        const ultimaDoTeto = linhasDeNegocio[linhasDeNegocio.length - 1]!;
        const { data: sobra, error: erroSobra } = await consultaDeNegocios()
          .or(filtroDepoisDoCursor({ created_at: ultimaDoTeto.created_at, id: ultimaDoTeto.id }, "asc"))
          .limit(1);
        if (erroSobra) throw new Error(`audiência: negócios — ${erroSobra.message}`);
        truncado = (sobra ?? []).length > 0;
        break;
      }
    }
    idsPorNegocio = [...new Set(linhasDeNegocio.map((l) => l.contact_id))];
    // Recorte de negócio que não achou ninguém é recorte vazio, não recorte
    // ausente: seguir sem o `in` devolveria a organização inteira.
    if (idsPorNegocio.length === 0) return { candidatos: [], truncado };
  }

  // ─── A consulta de contatos ───
  // Dois filtros deste módulo crescem com a organização e não cabem na URL: os
  // ids de negócio do recorte (até 20.000) e a lista de excluídos (até 5.000).
  // O gateway na frente do PostgREST devolve `414` acima de ~8.192 B (#2358, a
  // mesma família do #2357 em `leadsMaisRecentes`). Por isso:
  //   * a exclusão sai da URL e vira filtro em MEMÓRIA, ANTES do corte — é o
  //     que o `.not("id","in",…)` fazia no servidor;
  //   * com recorte de negócio, a consulta é fatiada por `buscaEmLotes`;
  //   * sem ele, a consulta é única e paginada por `max_rows`, parando cedo.
  const excluidos = new Set(filtro.excluir_contatos);
  const consultaDeContatos = () => {
    let consulta = admin
      .from("contacts")
      .select(COLUNAS_DO_CONTATO + colunasDeContato + ", created_at")
      .eq("organization_id", organizationId)
      // Placeholder de GRUPO não recebe campanha: campanha é 1:1 por doutrina, e
      // o grupo não tem opt-in individual nenhum por trás desse registro técnico.
      .eq("kind", "person")
      // Cadastro mesclado é fantasma: quem responde é o sobrevivente.
      .is("is_merged_into", null)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true });
    if (filtro.com_todas_tags.length > 0) consulta = consulta.contains("tags", filtro.com_todas_tags);
    if (filtro.com_alguma_tag.length > 0) consulta = consulta.overlaps("tags", filtro.com_alguma_tag);
    if (filtro.sem_tags.length > 0) {
      consulta = consulta.not("tags", "ov", `{${filtro.sem_tags.map(citar).join(",")}}`);
    }
    if (filtro.origens.length > 0) consulta = consulta.in("source", filtro.origens);
    if (filtro.sem_interacao_ha_dias !== null) {
      const limite = limiteDeSilencio(filtro.sem_interacao_ha_dias, agora).toISOString();
      // Quem nunca interagiu ENTRA no recorte de silêncio: `last_activity_at` nulo
      // é o silêncio mais longo que existe, e deixá-lo de fora tiraria justamente
      // a lista fria — que é o caso de uso principal da campanha.
      consulta = consulta.or(`last_activity_at.is.null,last_activity_at.lt.${limite}`);
    }
    if (filtro.com_interacao_ha_dias !== null) {
      consulta = consulta.gte(
        "last_activity_at",
        limiteDeSilencio(filtro.com_interacao_ha_dias, agora).toISOString(),
      );
    }
    if (filtro.cadastrado_de) consulta = consulta.gte("created_at", filtro.cadastrado_de);
    if (filtro.cadastrado_ate) consulta = consulta.lte("created_at", filtro.cadastrado_ate);
    return consulta;
  };

  // O select é DINÂMICO (a coluna `custom_fields` só entra quando o texto pede),
  // então o PostgREST não infere as colunas e devolve o tipo genérico: o `unknown`
  // é o preço, e `LinhaDeContato` continua sendo conferido por quem monta a linha.
  let linhas: LinhaDeContato[];
  if (idsPorNegocio) {
    // Cada lote traz no MÁXIMO 100 linhas (um id por contato, e os lotes do
    // `buscaEmLotes` têm 100 ids), então a união é o recorte inteiro — a
    // exclusão e o corte global acontecem UMA vez, no fim. Um `.limit` por lote
    // cortaria a união antes da exclusão em memória: um lote com muitas linhas
    // excluídas empurraria para fora quem deveria entrar.
    const { data, error } = await buscaEmLotes<LinhaDeContato>(idsPorNegocio, async (lote) => {
      const { data: pagina, error: erro } = await consultaDeContatos().in("id", lote);
      return { data: (pagina ?? null) as unknown as LinhaDeContato[] | null, error: erro };
    });
    if (error) throw new Error(`audiência: contatos — ${error.message}`);
    linhas = data.filter((l) => !excluidos.has(l.id));
    // Comparação ORDINAL, não `localeCompare`: a colação ICU põe `.` antes de
    // `+`, e um `…56+00:00` (segundo exato) cairia DEPOIS de um `…56.5+00:00`,
    // o contrário do `ORDER BY` do Postgres. Com timestamp em UTC no formato do
    // PostgREST e uuid em hex minúsculo, a ordem de bytes é a do banco.
    linhas.sort((a, b) => ordinal(a.created_at, b.created_at) || ordinal(a.id, b.id));
  } else {
    // Sem recorte de negócio não há por onde fatiar: uma consulta, por keyset em
    // (`created_at`, `id`) — a página CURTA não prova nada quando o `max_rows`
    // da instalação é menor que `PAGINA_DO_POSTGREST`; só a VAZIA prova
    // (#2404). O cursor é a última linha LIDA, não a última guardada: a
    // exclusão acontece depois da leitura.
    linhas = [];
    let cursorContatos: CursorDeLeitura | null = null;
    for (;;) {
      let consulta = consultaDeContatos().limit(PAGINA_DO_POSTGREST);
      if (cursorContatos) consulta = consulta.or(filtroDepoisDoCursor(cursorContatos, "asc"));
      const { data, error } = await consulta;
      if (error) throw new Error(`audiência: contatos — ${error.message}`);
      const pagina = (data ?? []) as unknown as LinhaDeContato[];
      if (pagina.length === 0) break;
      const ultima = pagina[pagina.length - 1]!;
      const novo = { created_at: ultima.created_at, id: ultima.id };
      if (cursorContatos && !avancou(cursorContatos, novo, "asc")) {
        throw new Error("audiência: audiencia_page_did_not_advance");
      }
      cursorContatos = novo;
      for (const l of pagina) if (!excluidos.has(l.id)) linhas.push(l);
      if (linhas.length >= filtro.limite) break;
    }
  }
  if (linhas.length > filtro.limite) linhas = linhas.slice(0, filtro.limite);

  // ─── Os incluídos à mão ───
  // Entram mesmo fora do recorte, e por isso vêm em consulta própria; os vetos
  // por pessoa continuam valendo para eles (incluir à mão não fura opt-out).
  const jaTem = new Set(linhas.map((l) => l.id));
  // Deduplicado ANTES dos lotes: o mesmo id em dois lotes voltaria duas vezes,
  // e a gravação da campanha esbarraria no contato único por campanha.
  const faltam = [...new Set(filtro.incluir_contatos)].filter((id) => !jaTem.has(id));
  if (faltam.length > 0) {
    // Em lotes pela mesma razão do recorte: até 5.000 ids não cabem numa URL.
    const { data: extras, error: erroExtras } = await buscaEmLotes<LinhaDeContato>(
      faltam,
      async (lote) => {
        const { data: pagina, error: erro } = await admin
          .from("contacts")
          .select(COLUNAS_DO_CONTATO + colunasDeContato + ", created_at")
          .eq("organization_id", organizationId)
          .eq("kind", "person")
          .in("id", lote);
        return { data: (pagina ?? null) as unknown as LinhaDeContato[] | null, error: erro };
      },
    );
    if (erroExtras) throw new Error(`audiência: incluídos — ${erroExtras.message}`);
    linhas.push(...(extras ?? []));
  }

  // ─── Os campos personalizados que o TEXTO usa ───
  // Uma consulta só, e só quando o corpo tem `{{lead.x}}`: o PostgREST não
  // devolve "o mais novo de cada contato", então a ordem decrescente resolve —
  // o primeiro visto de cada contato é o negócio mais recente dele.
  const leads = camposDoTexto.lead
    ? await leadsMaisRecentes(admin, organizationId, linhas.map((l) => l.id))
    : null;

  return {
    candidatos: linhas.map((l) => ({
      contactId: l.id,
      nome: nomeDoContato(l),
      telefone: l.phone_number,
      bloqueado: l.is_blocked,
      pessoal: l.is_personal === true,
      anonimizado: l.is_anonymized,
      recusouMarketing: recusouMarketing(l.consent),
      ...(camposDoTexto.contato ? { contato: mapaDeJson(l.custom_fields) } : {}),
      ...(leads ? { lead: leads.get(l.id) ?? null } : {}),
    })),
    truncado,
  };
}

/**
 * O negócio de UM destinatário, o mais recente — a mesma régua da prévia.
 *
 * Caminho do envio de TESTE (`acoes.ts`), que lê um contato por vez: teste que
 * renderiza por outro caminho que o envio não testa nada.
 */
export async function camposDoDestinatario(
  admin: SupabaseClient,
  entrada: { organizationId: string; contactId: string; corpo: string },
): Promise<{ lead?: CamposPersonalizados | null; contato?: CamposPersonalizados | null }> {
  const campos = camposUsadosNoTexto(entrada.corpo);
  if (!campos.lead && !campos.contato) return {};
  const saida: { lead?: CamposPersonalizados | null; contato?: CamposPersonalizados | null } = {};
  if (campos.contato) {
    const { data, error } = await admin
      .from("contacts")
      .select("custom_fields")
      .eq("organization_id", entrada.organizationId)
      .eq("id", entrada.contactId)
      .maybeSingle();
    if (error) throw new Error(`audiência: campos do contato — ${error.message}`);
    saida.contato = mapaDeJson((data as { custom_fields?: unknown } | null)?.custom_fields);
  }
  if (campos.lead) {
    const leads = await leadsMaisRecentes(admin, entrada.organizationId, [entrada.contactId]);
    saida.lead = leads.get(entrada.contactId) ?? null;
  }
  return saida;
}

/**
 * O negócio mais recente de cada contato.
 *
 * `{{lead.gancho}}` é do lead mais NOVO do contato — o que o operador vê
 * quando abre a ficha. Contato sem negócio devolve SEM linha no mapa, e aí o
 * renderizador marca FALTA: a pessoa sai da lista com `variavel_ausente`,
 * visível na prévia, em vez de receber o texto pela metade.
 *
 * Os ids viajam NA URL (`contact_id=in.(…)`), e o gateway na frente do
 * PostgREST (Kong 2.8.1 no stack Supabase e no kit single-server) devolve `414`
 * acima de ~8.192 B — ver `tests/unit/busca-do-inbox-nao-estoura-a-url.test.ts`.
 * Todos de uma vez, a audiência padrão de 500 contatos dava ~19,7 KB e a
 * preparação INTEIRA caía. Por isso `buscaEmLotes` (100 uuids ≈ 3,7 KB por URL).
 *
 * Dentro do lote vêm TODAS as linhas, paginadas pelo `max_rows`: um `.limit`
 * global cortava quem tem o negócio mais antigo, e o contato saía da lista com
 * o campo preenchido. Cada contato cai num lote só, então a ordem decrescente
 * dele sobrevive à concatenação.
 */
async function leadsMaisRecentes(
  admin: SupabaseClient,
  organizationId: string,
  contactIds: readonly string[],
): Promise<Map<string, CamposPersonalizados | null>> {
  const mapa = new Map<string, CamposPersonalizados | null>();
  if (contactIds.length === 0) return mapa;
  const { data, error } = await buscaEmLotes(contactIds, async (lote) => {
    const linhas: Array<{
      contact_id: string;
      custom_fields: unknown;
      created_at: string;
      id: string;
    }> = [];
    // Keyset em (`created_at`, `id`) DECRESCENTE, como a ordem pedida: a página
    // curta não prova nada quando o `max_rows` da instalação é menor que
    // `PAGINA_DO_POSTGREST`; só a VAZIA prova (#2404).
    let cursor: CursorDeLeitura | null = null;
    for (;;) {
      let consulta = admin
        .from("crm_leads")
        .select("contact_id, custom_fields, created_at, id")
        .eq("organization_id", organizationId)
        .in("contact_id", lote)
        .not("contact_id", "is", null)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(PAGINA_DO_POSTGREST);
      if (cursor) consulta = consulta.or(filtroDepoisDoCursor(cursor, "desc"));
      const { data: pagina, error: erro } = await consulta;
      if (erro) return { data: null, error: erro };
      const lidas = (pagina ?? []) as unknown as typeof linhas;
      if (lidas.length === 0) return { data: linhas, error: null };
      const ultima = lidas[lidas.length - 1]!;
      const novo = { created_at: ultima.created_at, id: ultima.id };
      if (cursor && !avancou(cursor, novo, "desc")) {
        return { data: null, error: { message: "audiencia_page_did_not_advance" } };
      }
      cursor = novo;
      linhas.push(...lidas);
    }
  });
  if (error) throw new Error(`audiência: negócios dos contatos — ${error.message}`);
  for (const linha of data) {
    if (mapa.has(linha.contact_id)) continue; // ordem decrescente: o primeiro é o mais novo
    mapa.set(linha.contact_id, mapaDeJson(linha.custom_fields));
  }
  return mapa;
}

/** Lê `custom_fields` sem confiar no shape — é jsonb livre. */
function mapaDeJson(valor: unknown): CamposPersonalizados | null {
  if (!valor || typeof valor !== "object" || Array.isArray(valor)) return null;
  return valor as CamposPersonalizados;
}


/**
 * Quem já está em campanha VIVA desta organização.
 *
 * Opcionalmente ignora uma campanha (a que está sendo preparada): sem isso, uma
 * preparação repetida excluiria como "já em campanha" os destinatários que ela
 * mesma gravou na tentativa anterior.
 */
export async function contatosJaEmCampanha(
  admin: SupabaseClient,
  organizationId: string,
  exceto?: string,
): Promise<Set<string>> {
  let vivas = admin
    .from("campaigns")
    .select("id")
    .eq("organization_id", organizationId)
    .in("status", CAMPANHAS_VIVAS);
  if (exceto) vivas = vivas.neq("id", exceto);
  const { data: campanhas, error } = await vivas;
  if (error) throw new Error(`audiência: campanhas vivas — ${error.message}`);
  const ids = (campanhas ?? []).map((c) => (c as { id: string }).id);
  if (ids.length === 0) return new Set();

  const { data, error: erroDest } = await admin
    .from("campaign_recipients")
    .select("contact_id")
    .eq("organization_id", organizationId)
    .in("campaign_id", ids);
  if (erroDest) throw new Error(`audiência: comprometidos — ${erroDest.message}`);
  return new Set((data ?? []).map((r) => (r as { contact_id: string }).contact_id));
}

function ordinal(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Aspas para o literal de array do Postgres — etiqueta com vírgula quebraria o `{a,b}`. */
function citar(valor: string): string {
  return `"${valor.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
