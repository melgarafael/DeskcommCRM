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

/** O teto de linhas por resposta do PostgREST (`max_rows` em `supabase/config.toml`). */
const PAGINA_DE_NEGOCIOS = 1000;

/** Teto de ids que um filtro de negócio devolve antes de virar `in (...)`. */
const TETO_DE_IDS_DE_NEGOCIO = 20_000;

interface LinhaDeContato {
  id: string;
  name: string | null;
  display_name: string | null;
  phone_number: string | null;
  is_blocked: boolean;
  is_anonymized: boolean;
  consent: unknown;
  /** Só quando o texto pede `{{contato.x}}` — ver `colunasDeContato`. */
  custom_fields?: unknown;
}

/** As colunas de sempre, mais os campos personalizados quando o TEXTO os usa. */
const COLUNAS_DO_CONTATO = "id, name, display_name, phone_number, is_blocked, is_anonymized, consent";

export async function buscarCandidatos(
  admin: SupabaseClient,
  entrada: { organizationId: string; filtro: FiltroDeAudiencia; agora: Date; corpo?: string },
): Promise<CandidatoDaAudiencia[]> {
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
  if (usaNegocio(filtro)) {
    let negocios = admin
      .from("crm_leads")
      .select("contact_id")
      .eq("organization_id", organizationId)
      .not("contact_id", "is", null)
      .limit(TETO_DE_IDS_DE_NEGOCIO);
    if (filtro.funis.length > 0) negocios = negocios.in("pipeline_id", filtro.funis);
    if (filtro.etapas.length > 0) negocios = negocios.in("stage_id", filtro.etapas);
    if (filtro.responsaveis.length > 0) negocios = negocios.in("owner_user_id", filtro.responsaveis);
    if (filtro.situacoes_do_negocio.length > 0) {
      negocios = negocios.in("status", filtro.situacoes_do_negocio);
    }
    const { data, error } = await negocios;
    if (error) throw new Error(`audiência: negócios — ${error.message}`);
    idsPorNegocio = [...new Set((data ?? []).map((l) => (l as { contact_id: string }).contact_id))];
    // Recorte de negócio que não achou ninguém é recorte vazio, não recorte
    // ausente: seguir sem o `in` devolveria a organização inteira.
    if (idsPorNegocio.length === 0) return [];
  }

  let consulta = admin
    .from("contacts")
    .select(COLUNAS_DO_CONTATO + colunasDeContato)
    .eq("organization_id", organizationId)
    // Placeholder de GRUPO não recebe campanha: campanha é 1:1 por doutrina, e
    // o grupo não tem opt-in individual nenhum por trás desse registro técnico.
    .eq("kind", "person")
    // Cadastro mesclado é fantasma: quem responde é o sobrevivente.
    .is("is_merged_into", null)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(filtro.limite);

  if (idsPorNegocio) consulta = consulta.in("id", idsPorNegocio);
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
  if (filtro.excluir_contatos.length > 0) {
    consulta = consulta.not("id", "in", `(${filtro.excluir_contatos.join(",")})`);
  }

  const { data, error } = await consulta;
  if (error) throw new Error(`audiência: contatos — ${error.message}`);
  // O select é DINÂMICO (a coluna `custom_fields` só entra quando o texto pede),
  // então o PostgREST não infere as colunas e devolve o tipo genérico: o `unknown`
  // é o preço, e `LinhaDeContato` continua sendo conferido por quem monta a linha.
  const linhas = (data ?? []) as unknown as LinhaDeContato[];

  // ─── Os incluídos à mão ───
  // Entram mesmo fora do recorte, e por isso vêm em consulta própria; os vetos
  // por pessoa continuam valendo para eles (incluir à mão não fura opt-out).
  const jaTem = new Set(linhas.map((l) => l.id));
  const faltam = filtro.incluir_contatos.filter((id) => !jaTem.has(id));
  if (faltam.length > 0) {
    const { data: extras, error: erroExtras } = await admin
      .from("contacts")
      .select(COLUNAS_DO_CONTATO + colunasDeContato)
      .eq("organization_id", organizationId)
      .eq("kind", "person")
      .in("id", faltam);
    if (erroExtras) throw new Error(`audiência: incluídos — ${erroExtras.message}`);
    linhas.push(...((extras ?? []) as unknown as LinhaDeContato[]));
  }

  // ─── Os campos personalizados que o TEXTO usa ───
  // Uma consulta só, e só quando o corpo tem `{{lead.x}}`: o PostgREST não
  // devolve "o mais novo de cada contato", então a ordem decrescente resolve —
  // o primeiro visto de cada contato é o negócio mais recente dele.
  const leads = camposDoTexto.lead
    ? await leadsMaisRecentes(admin, organizationId, linhas.map((l) => l.id))
    : null;

  return linhas.map((l) => ({
    contactId: l.id,
    nome: nomeDoContato(l),
    telefone: l.phone_number,
    bloqueado: l.is_blocked,
    anonimizado: l.is_anonymized,
    recusouMarketing: recusouMarketing(l.consent),
    ...(camposDoTexto.contato ? { contato: mapaDeJson(l.custom_fields) } : {}),
    ...(leads ? { lead: leads.get(l.id) ?? null } : {}),
  }));
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
    const linhas: Array<{ contact_id: string; custom_fields: unknown }> = [];
    for (let de = 0; ; de += PAGINA_DE_NEGOCIOS) {
      const { data: pagina, error: erro } = await admin
        .from("crm_leads")
        .select("contact_id, custom_fields")
        .eq("organization_id", organizationId)
        .in("contact_id", lote)
        .not("contact_id", "is", null)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(de, de + PAGINA_DE_NEGOCIOS - 1);
      if (erro) return { data: null, error: erro };
      linhas.push(...((pagina ?? []) as typeof linhas));
      if ((pagina ?? []).length < PAGINA_DE_NEGOCIOS) return { data: linhas, error: null };
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

/** Aspas para o literal de array do Postgres — etiqueta com vírgula quebraria o `{a,b}`. */
function citar(valor: string): string {
  return `"${valor.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
