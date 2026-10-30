/**
 * GET /api/v1/pipelines/[id]/leads?page=&per_page=&owner=&status=
 *
 * A página da LISTA do funil (#3172, fatia 1): uma fatia dos negócios do funil,
 * lida do banco com `range`, mais o `meta` que diz qual página é e se há
 * próxima (`page`, `per_page`, `has_more` — sem total).
 *
 * ─── Por que uma rota nova, e não a do quadro ───────────────────────────────
 *
 * `GET /api/v1/pipelines/[id]/board` lê o funil INTEIRO de propósito: o quadro
 * precisa de todas as colunas montadas de uma vez, e é ele que alimenta o pulso
 * de realtime e o filtro em memória da barra. Enfiar paginação lá dentro
 * mudaria o contrato de quem já depende dele (o Kanban, o diálogo de negócio
 * duplicado, o seletor de motivos de perda) sem que nenhum desses precisasse
 * disso. Esta rota nasce AO LADO, com o custo da página em vez do funil.
 *
 * ⚠️ O `range` corta o que VOLTA, não o que o banco AVALIA: sem índice na ordem
 * pedida o Postgres ainda passa a regra de visibilidade em todas as linhas do
 * funil antes de ordenar (medido pelo mantenedor: 3.901 chamadas de
 * `fn_can_view_lead` e ~3,8 s na página 1 de um funil com 3.901 negócios). Quem
 * faz o corte ser de verdade é o índice `idx_crm_leads_org_pipeline_position_id`
 * (migration 0739), sobre as MESMAS colunas que o `select` filtra e ordena.
 *
 * ─── Os filtros da barra (fatia 2, primeira parte) ─────────────────────────
 *
 * `owner` e `status` — os MESMOS valores que a barra escreve na URL do funil —
 * entram na consulta, ANTES do `range`. Filtrar a página depois de lida
 * esconderia os negócios das páginas seguintes: com "Responsável: Ana", a
 * página 1 mostraria só os da Ana que caíram nela. Valor que não se entende é
 * 422, nunca o funil inteiro com cara de filtrado. A regra de cada valor mora
 * em `lib/kanban/filtros-da-lista.ts`.
 *
 * ─── O que esta fatia NÃO faz ──────────────────────────────────────────────
 *
 * Busca, etiqueta, atrasados, motivo e categoria (o resto da fatia 2; a tela
 * avisa quando um deles está ativo), ordenação por cabeçalho, escolha de colunas,
 * seleção em lote e visões salvas (fatia 3). A ordem é a do quadro
 * (`position_in_stage`), a mesma que o operador já vê nas colunas — ordenar por
 * outra coluna sem a tela que a pede seria contrato sem chamador.
 *
 * ─── Isolamento ────────────────────────────────────────────────────────────
 *
 * `organization_id` sai do cookie de sessão validado (`requireRole`), nunca do
 * corpo nem da URL, e é filtrado explicitamente além da RLS. O funil é
 * conferido antes: id de outro tenant devolve 404, não uma lista vazia — "não
 * existe" e "não tem negócio" são respostas diferentes, e a segunda mente.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { donoDoFiltro, lerFiltrosDaLista } from "@/lib/kanban/filtros-da-lista";
import { createClient } from "@/lib/supabase/server";
import type { Lead } from "@/lib/types/leads";

export const dynamic = "force-dynamic";

/** O tamanho de página que a tela pede por padrão (issue #3172: 50/100/200). */
export const LEADS_POR_PAGINA = 50;

/** O teto do que a URL pode pedir. Acima disso a página é honesta, não gigante. */
export const LEADS_POR_PAGINA_MAX = 200;

interface RouteCtx {
  params: Promise<{ id: string }>;
}

/**
 * A página pedida, inteiro ≥ 1 escrito só com dígitos. Ausente ou inválida
 * (`0`, `-3`, `abc`, `2x`) vale 1: responder `meta.page: 3` para uma URL que
 * pediu outra coisa seria a resposta mentir sobre a pergunta.
 */
function paginaPedida(bruto: string | null): number {
  if (bruto === null || !/^\d+$/.test(bruto.trim())) return 1;
  const n = Number(bruto.trim());
  return Number.isSafeInteger(n) && n >= 1 ? n : 1;
}

/**
 * O tamanho da página, entre 1 e `LEADS_POR_PAGINA_MAX`. Inválido ou ausente cai
 * no padrão; acima do teto é o teto, e não um 422 — a tela que pediu 500 quer
 * "o máximo que der", e recusar a lista inteira por causa disso é pior.
 */
function porPaginaPedido(bruto: string | null): number {
  if (bruto === null || !/^\d+$/.test(bruto.trim())) return LEADS_POR_PAGINA;
  const n = Number(bruto.trim());
  if (!Number.isSafeInteger(n) || n < 1) return LEADS_POR_PAGINA;
  return Math.min(n, LEADS_POR_PAGINA_MAX);
}

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id: pipelineId } = await ctx.params;

  // `viewer` é o piso: ler a lista do funil é a mesma permissão de abrir o
  // quadro. A ESCRITA continua onde sempre esteve, nas rotas de lead.
  const authz = await requireRole("viewer", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  const params = req.nextUrl.searchParams;
  const pagina = paginaPedida(params.get("page"));
  const porPagina = porPaginaPedido(params.get("per_page"));
  const de = (pagina - 1) * porPagina;

  const lidos = lerFiltrosDaLista(params);
  if (!lidos.ok) {
    return fail("validation_failed", t("Parâmetros inválidos."), 422, {
      requestId,
      details: { [lidos.campo]: ["valor desconhecido"] },
    });
  }
  const filtros = lidos.filtros;

  const supabase = await createClient();

  const { data: funil, error: funilErr } = await supabase
    .from("crm_pipelines")
    .select("id")
    .eq("id", pipelineId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (funilErr) {
    return fail("internal_error", funilErr.message, 500, { requestId });
  }
  if (!funil) {
    return fail("resource_not_found", t("Funil não encontrado."), 404, { requestId });
  }

  // ─── A contagem exata saiu; o `has_more` vem de UMA linha a mais ──────────
  //
  // O `count: "exact"` custava uma SEGUNDA consulta que avaliava o funil
  // inteiro (as mesmas 3.901 chamadas de `fn_can_view_lead` da página — medido
  // pelo mantenedor), e servia só para o `has_more` e para o "página X de Y" da
  // tela. A linha `per_page + 1` responde a MESMA pergunta (`há próxima página?`)
  // com o custo de uma linha, e sem prometer um total que ninguém pediu. O que
  // a tela perde é o "de Y": ela passa a dizer "página X" — um número que ela
  // SABE — em vez de um total que exigia varrer o funil.
  //
  // ⚠️ O `range` É O CONSERTO, e o índice é o que o torna barato. Sem ele esta
  // consulta lê o funil inteiro (o corte de 1.000 linhas do PostgREST vem
  // DEPOIS de o banco filtrar e ordenar tudo, e cada linha passa por
  // `fn_can_view_lead`), que é exatamente o problema que a issue mede — 19 s num
  // funil migrado, até estourar o `statement_timeout` do papel `authenticated`.
  let consulta = supabase
    .from("crm_leads")
    .select("*")
    .eq("pipeline_id", pipelineId)
    .eq("organization_id", orgId)
    .neq("status", "archived");
  // Os filtros da barra (fatia 2): na consulta, para o `range` cortar o que JÁ
  // passou no filtro. "Sem responsável" é sem dono NENHUM — negócio com agente
  // tem dono, a mesma regra do quadro.
  if (filtros.status) consulta = consulta.eq("status", filtros.status);
  if (filtros.owner) {
    const dono = donoDoFiltro(filtros.owner);
    consulta =
      dono === "ninguem"
        ? consulta.is("owner_user_id", null).is("owner_agent_id", null)
        : consulta.eq(dono.coluna, dono.id);
  }
  const { data, error } = await consulta
    .order("position_in_stage")
    // O DESEMPATE (`.order("id")`). Sem ele, dois negócios com a MESMA
    // `position_in_stage` — o lote que gravou a mesma posição em N linhas, ou
    // duas etapas que compartilham a posição — saem na ordem que o plano
    // escolher: a página 2 pode repetir um item que já veio na 1 e pular outro.
    // Com o desempate, a mesma URL devolve sempre as mesmas linhas.
    .order("id")
    .range(de, de + porPagina);
  if (error) {
    return fail("internal_error", error.message, 500, { requestId });
  }

  const linhas = (data ?? []) as Lead[];
  // A linha extra não vai para a tela: ela existe só para dizer se há próxima.
  const hasMore = linhas.length > porPagina;

  return ok(hasMore ? linhas.slice(0, porPagina) : linhas, {
    requestId,
    meta: {
      page: pagina,
      per_page: porPagina,
      // Pelo que VOLTOU, não por uma contagem: `per_page + 1` linhas provam que
      // existe pelo menos mais uma. É a verdade que a tela usa para habilitar o
      // `Próxima`; um total exato custaria a varredura do funil inteiro.
      has_more: hasMore,
    },
  });
}
