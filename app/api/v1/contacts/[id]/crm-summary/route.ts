/**
 * GET /api/v1/contacts/[id]/crm-summary — o resumo de CRM do painel do inbox.
 *
 * POR QUE ESTA ROTA EXISTE (não é organização, é correção de defeito):
 * o `CRMSidePanel` consultava `crm_leads`, `orders` e `crm_lead_activities`
 * DIRETO do navegador, pelo cliente de browser. O cookie de sessão é httpOnly
 * (CLAUDE.md), então o supabase-js do browser não enxerga a sessão e as
 * consultas saem como **anônimas** — provado lendo o `role` do token: `anon`,
 * com um gerente logado na tela.
 *
 * O efeito era pior que um erro:
 *   crm_leads           → a policy chama fn_can_view_lead, que `anon` não pode
 *                         executar → 401 / 42501
 *   crm_lead_activities → a policy usa fn_user_org_ids, que é PUBLIC → `anon`
 *                         chama, avalia falso → **200 com lista vazia**
 *   orders              → idem
 * Um erro e dois silêncios, e a tela traduzia os três para "Sem leads." — uma
 * afirmação sobre o NEGÓCIO feita em cima de uma falha de permissão.
 *
 * A correção **não** é dar EXECUTE a `anon`: `fn_can_view_lead` é primitiva de
 * autorização, e a policy a usa para decidir quem enxerga o quê. É trazer a
 * leitura para o servidor, onde a sessão existe — mesma decisão que o repo já
 * tomou para o fetch do board e para o token de realtime.
 *
 * **Um pedido, um veredito.** As três consultas falham juntas de propósito: a
 * alternativa (status por seção) triplicaria os estados no componente, e a
 * doença que esta rota cura é exatamente estados distintos colapsados num só.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { lerAnuncioDaMensagem, lerAnuncioDoContato, mesmoAnuncio } from "@/lib/leads/atribuicao-de-anuncio";
import { prospectEnrichmentSchema } from "@/lib/prospecting/schema";
import { lerPersonalizacao } from "@/lib/prospecting/personalizar";
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { ALVO_DE_CONTATO, VINCULO_DE_CONTATO } from "@/app/api/v1/leads/[id]/contatos-relacionados/route";
import { atalhosDoFunil } from "@/lib/leads/atalhos-do-card";
import { camposDoFunil, camposPorEscopo, settingsDoEmbed } from "@/lib/leads/campos-do-funil";
import { motivosDoFunil } from "@/lib/leads/motivos-de-perda-do-funil";
import { createClient } from "@/lib/supabase/server";
import { nomesDosAtendentes } from "@/lib/users/nome-do-atendente";

export const dynamic = "force-dynamic";

/**
 * Sem o embed do funil o painel não consegue montar os campos customizados.
 * Nome do funil e da etapa entram porque dois leads de mesmo título em funis
 * diferentes ficavam idênticos na lista (#943). `!inner` para filtrar funil
 * arquivado no banco, antes do `limit(3)` — `pipeline_id` é NOT NULL.
 */
// `stage_id` e as `etapas` do funil alimentam o seletor de etapa do painel: mover
// o negócio (ex.: "Pedido confirmado") direto da conversa, sem ir ao quadro.
const LEAD_COLS =
  "id, title, status, value_cents, recurring_value_cents, recurring_period, recurring_months, currency, updated_at, pipeline_id, stage_id, custom_fields, crm_pipelines!inner(name, settings, is_archived, etapas:crm_stages!crm_stages_pipeline_id_fkey(id, name, position, is_won, is_lost, is_archived)), crm_stages!crm_leads_stage_id_fkey(name)";
const ORDER_COLS = "id, external_id, status, total_cents, currency, created_at";
/** Acompanha o que a timeline mostra — `reason` e `actor_kind` inclusive. */
/**
 * `performed_by_user_id` entra porque a timeline dizia "Você/time" para TODA
 * ação humana — o painel sabia que uma pessoa agiu e nunca QUAL. Com a troca de
 * comando virando linha da timeline, "Transferiu a conversa · Você/time" seria a
 * resposta errada para a pergunta que a entrega existe para responder.
 */
const ACTIVITY_COLS =
  "id, type, source_module, performed_at, payload, reason, actor_kind, performed_by_user_id";
/**
 * Passo 4 do cap. 5 — a DEMANDA chega ao lugar onde o humano atende.
 *
 * O painel mostrava negócios, pedidos e histórico. Nenhum dos três responde à
 * pergunta que a pessoa do outro lado está fazendo: **o que ela pediu e ainda
 * não foi resolvido.** Lead é o negócio; conversa é o canal; demanda é o que
 * precisa acabar (doutrina cap. 5).
 *
 * O caso concreto que isto evita: o atendente encerra a conversa, a demanda
 * segue aberta e sem próximo passo, e o vazamento só aparece depois — como
 * número numa métrica que ele não abre. `proximo_passo` vem junto porque a
 * ausência dele é o próprio invariante 4, e é o que precisa saltar na tela.
 */
const DEMANDA_COLS =
  "id, revision, aberta_em, origem, estado, proximo_passo, proximo_passo_em, prazo_em";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id: contactId } = await ctx.params;

  const supabase = await createClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }

  const { data: contactScope, error: scopeError } = await supabase.from("contacts")
    .select("organization_id, is_anonymized, source_metadata").eq("id", contactId).maybeSingle();
  if (scopeError) return fail("internal_error", scopeError.message, 500, { requestId });
  if (!contactScope) return fail("not_found", "Contato não encontrado.", 404, { requestId });
  // Candidates are worker-only. Authorize the contact through RLS first, then
  // scope this read to that exact contact and organization. Never expose raw data.
  const enrichment = await (async () => {
    if (contactScope.is_anonymized) return { enrichment: null, enrichment_error: false };
    try {
      const admin = createAdminClient();
      const candidato = await admin.from("prospecting_candidates")
        .select("data, created_at")
        .eq("organization_id", contactScope.organization_id).eq("contact_id", contactId)
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (candidato.error) return { enrichment: null, enrichment_error: true };
      if (!candidato.data) return { enrichment: null, enrichment_error: false };
      const parsed = prospectEnrichmentSchema.safeParse(candidato.data.data);
      if (!parsed.success) return { enrichment: null, enrichment_error: true };
      // Personalização só quando há auditoria para personalizar: sem `site`
      // não há vocabulário a sobrescrever, e a query a mais sairia de graça
      // em todo painel aberto (é o caminho quente do inbox).
      let personalizacao = null;
      if (parsed.data.site) {
        const organizacao = await admin.from("organizations")
          .select("settings")
          .eq("id", contactScope.organization_id)
          .maybeSingle();
        if (!organizacao.error) {
          personalizacao = lerPersonalizacao(
            (organizacao.data as { settings?: unknown } | null)?.settings,
          );
        }
      }
      return {
        enrichment: { ...parsed.data, collected_at: candidato.data.created_at },
        enrichment_error: false,
        personalizacao,
      };
    } catch {
      return { enrichment: null, enrichment_error: true };
    }
  })();
  const anuncios = await anunciosDoContato(supabase, contactId, contactScope);
  // ─── Fatia 2a da #3669: número adicional também mostra o negócio ──────────
  // O contato desta conversa pode ser um número ADICIONAL do cliente (um
  // `crm_lead_links` com `target_kind='contact'`, `link_kind='related'`). Nesse
  // caso o negócio tem `contact_id` do contato PRINCIPAL, e a leitura por
  // `contact_id` devolveria vazio. Consultamos os vínculos antes e, se o
  // contato não tiver negócio próprio ABERTO (a precedência da 1a: próprio
  // aberto vence), trazemos os negócios em que ele aparece como relacionado.
  const { data: vinculosRelacionados, error: vinculosErr } = await supabase
    .from("crm_lead_links")
    .select("lead_id")
    .eq("organization_id", contactScope.organization_id)
    .eq("target_kind", ALVO_DE_CONTATO)
    .eq("link_kind", VINCULO_DE_CONTATO)
    .eq("target_id", contactId);
  const idsRelacionados = (vinculosRelacionados ?? [])
    .map((v: { lead_id?: string }) => v.lead_id)
    .filter((v): v is string => typeof v === "string" && v.length > 0);

  // Próprio ABERTO primeiro: se o contato tem negócio próprio aberto, ele vence
  // o relacionado (mesma regra de `lib/leads/active-lead.ts`).
  const { data: leadsProprios, error: leadsPropriosErr } = await supabase
    .from("crm_leads")
    .select(LEAD_COLS)
    .eq("contact_id", contactId).eq("organization_id", contactScope.organization_id)
    .eq("crm_pipelines.is_archived", false)
    .order("updated_at", { ascending: false })
    .limit(3);
  // Sem `if` vazio: a falha desta leitura entra na varredura de `falha` abaixo,
  // junto das outras, para o painel ver um veredito só.

  // Próprio só FECHADO não vence: o cartão "(2º número)" duplicado que alguém
  // fechou depois de juntar esconderia o negócio vivo do cliente.
  const proprios = leadsProprios ?? [];
  let leadsResolvidos = proprios;
  let leadsRelErr: { message: string } | null = null;
  if (idsRelacionados.length > 0 && !proprios.some((l) => l.status === "open")) {
    const { data: leadsRel, error } = await supabase
      .from("crm_leads")
      .select(LEAD_COLS)
      .eq("organization_id", contactScope.organization_id)
      .eq("crm_pipelines.is_archived", false)
      .in("id", idsRelacionados)
      .order("updated_at", { ascending: false })
      .limit(3);
    leadsRelErr = error;
    const rel = leadsRel ?? [];
    leadsResolvidos = [
      ...rel.filter((l) => l.status === "open"),
      ...proprios,
      ...rel.filter((l) => l.status !== "open"),
    ].slice(0, 3);
  }

  const [orders, activities, demandas, fatos, historico] = await Promise.all([
    supabase
      .from("orders")
      .select(ORDER_COLS)
      .eq("contact_id", contactId).eq("organization_id", contactScope.organization_id)
      .order("created_at", { ascending: false })
      .limit(3),
    // 12 e não 5. A janela de 5 foi dimensionada quando a timeline não recebia
    // troca de comando: agora um atendimento normal (assumiu → transferiu →
    // liberou → voltou ao automático) gasta QUATRO linhas sozinho, e com 5 o
    // painel mostraria só a movimentação de dono, empurrando para fora o que o
    // negócio fez. 12 cabe sem rolagem própria na coluna de 296px.
    supabase
      .from("crm_lead_activities")
      .select(ACTIVITY_COLS)
      .eq("contact_id", contactId).eq("organization_id", contactScope.organization_id)
      .order("performed_at", { ascending: false })
      .limit(12),
    // Só as ABERTAS: demanda encerrada é histórico e já vive na timeline. Da
    // mais antiga para a mais nova — quem espera há mais tempo aparece primeiro,
    // mesma régua do Radar, para as duas telas não contarem histórias
    // diferentes sobre o mesmo contato.
    supabase
      .from("demandas")
      .select(DEMANDA_COLS)
      .eq("contact_id", contactId).eq("organization_id", contactScope.organization_id)
      .is("fechada_em", null)
      .order("aberta_em", { ascending: true })
      .limit(5),
    supabase.from("lead_notes").select("id, headline, body").eq("contact_id", contactId).eq("organization_id", contactScope.organization_id).order("created_at", { ascending: false }).limit(20),
    supabase.from("demandas").select("id, desfecho, fechada_em").eq("contact_id", contactId).eq("organization_id", contactScope.organization_id).not("fechada_em", "is", null).order("fechada_em", { ascending: false }).limit(5),
  ]);

  // A falha SOBE. Engolir aqui devolveria lista vazia ao cliente e recriaria,
  // do lado do servidor, exatamente a mentira que esta rota veio desfazer.
  // Varredura e não encadeamento de `??`: o `error` que o supabase-js tipa para
  // estas leituras vem como `null` (o TS sabe disso e reprovaria `a ?? b` com
  // “sempre nullish”), mas em runtime ele PODE vir preenchido — o encadeamento
  // some no typecheck e o runtime continua vendo o erro. `.find` mantém a mesma
  // semântica (o primeiro erro vence) sem depender do tipo declarado.
  const falha = [
    vinculosErr,
    leadsPropriosErr,
    leadsRelErr,
    orders.error,
    activities.error,
    demandas.error,
    fatos.error,
    historico.error,
  ].find((e) => e != null);
  if (falha) {
    return fail("internal_error", falha.message, 500, { requestId });
  }

  // QUEM agiu, e não só "uma pessoa". O lookup roda sobre os autores DISTINTOS
  // da janela (12 linhas, quase sempre 1 ou 2 pessoas), e degrada declarado
  // quando não há service role — a tela cai no rótulo genérico que ela já usava.
  const linhas = (activities.data ?? []) as Array<{
    performed_by_user_id?: string | null;
    [k: string]: unknown;
  }>;
  const nomes = await nomesDosAtendentes(linhas.map((a) => a.performed_by_user_id ?? null));

  return ok(
    {
      ...enrichment,
      leads: leadsResolvidos.map((row) => comCamposDoFunil(row as Record<string, unknown>)),
      orders: orders.data ?? [],
      activities: linhas.map((a) => ({
        ...a,
        performed_by_name: a.performed_by_user_id
          ? (nomes.get(a.performed_by_user_id) ?? null)
          : null,
      })),
      demandas: demandas.data ?? [],
      fatos: fatos.data ?? [], historico: historico.data ?? [],
      ...anuncios,
    },
    { requestId },
  );
}

/**
 * De qual anúncio a pessoa veio, para o painel ao lado da conversa.
 *
 * Dois anúncios, porque são duas perguntas: o de ORIGEM (primeiro toque, o que
 * o contato guarda e nunca reescreve) e o MAIS RECENTE que ela clicou, quando é
 * outro — numa loja com vários produtos, quem chegou pelo anúncio de um e
 * voltou pelo de outro está falando do segundo.
 *
 * Auxiliar e por isso fora do `Promise.all` de cima: a leitura da mensagem que
 * falha vira "sem anúncio mais recente", nunca um painel inteiro em erro. E
 * contato anonimizado não mostra anúncio nenhum.
 */
async function anunciosDoContato(
  supabase: Awaited<ReturnType<typeof createClient>>,
  contactId: string,
  contato: { organization_id: string; is_anonymized: boolean | null; source_metadata: unknown },
) {
  if (contato.is_anonymized) return { anuncio_de_origem: null, anuncio_mais_recente: null };
  const origem = lerAnuncioDoContato(contato.source_metadata);
  const { data, error } = await supabase
    .from("messages")
    .select("anuncio:metadata->anuncio, created_at")
    .eq("contact_id", contactId)
    .eq("organization_id", contato.organization_id)
    .eq("direction", "inbound")
    .not("metadata->anuncio", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const linha = error ? null : (data as { anuncio: unknown; created_at: string } | null);
  const recente = linha ? lerAnuncioDaMensagem(linha.anuncio) : null;
  const outro = recente && !(origem && mesmoAnuncio(origem, recente));
  return {
    anuncio_de_origem: origem,
    anuncio_mais_recente: outro ? { ...recente, recebido_em: linha!.created_at } : null,
  };
}

function comCamposDoFunil(row: Record<string, unknown>) {
  const { crm_pipelines, crm_stages, ...lead } = row;
  return {
    ...lead,
    field_defs: camposPorEscopo(camposDoFunil(settingsDoEmbed(crm_pipelines)), "negocio"),
    funil_nome: nomeDoEmbed(crm_pipelines),
    etapa_nome: nomeDoEmbed(crm_stages),
    etapas_do_funil: etapasDoEmbed(crm_pipelines),
    // O painel da conversa não tem o quadro em cache; sem isto a janela de perda cairia no padrão do produto.
    motivos_de_perda: motivosDoFunil(settingsDoEmbed(crm_pipelines)),
    // OS ATALHOS DO CARD (#3487). Vai o MODELO de link como está no `settings`,
    // não o link montado: quem monta é o navegador de quem clica, com os dados
    // que essa pessoa já vê (`encodeURIComponent` por valor, allowlist de
    // esquema na renderização). Montar aqui exigiria trazer telefone e campos
    // para o servidor só para devolver string — e o link pronto no JSON é dado
    // do cliente viajando a mais, sem uso.
    atalhos: atalhosDoFunil(settingsDoEmbed(crm_pipelines)),
  };
}

/** As etapas ATIVAS do funil do negócio, na ordem do quadro. */
function etapasDoEmbed(embed: unknown): Array<{ id: string; name: string; is_won: boolean; is_lost: boolean }> {
  const alvo = Array.isArray(embed) ? embed[0] : embed;
  const etapas = (alvo as { etapas?: unknown } | null)?.etapas;
  if (!Array.isArray(etapas)) return [];
  return (etapas as Array<{ id: string; name: string; position: number | string; is_won: boolean; is_lost: boolean; is_archived: boolean }>)
    .filter((e) => !e.is_archived)
    .sort((a, b) => Number(a.position) - Number(b.position))
    .map((e) => ({ id: e.id, name: e.name, is_won: e.is_won, is_lost: e.is_lost }));
}

function nomeDoEmbed(embed: unknown): string | null {
  const alvo = Array.isArray(embed) ? embed[0] : embed;
  const nome = (alvo as { name?: unknown } | null)?.name;
  return typeof nome === "string" ? nome : null;
}
