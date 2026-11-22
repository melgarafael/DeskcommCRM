/**
 * GET /api/v1/ai/evolution — o Painel de Evolução da IA (Fase 4 do Harness).
 *
 * Lê o que as fases 0-3 depositaram — memória da org, propostas aplicadas do
 * flywheel, skills instaladas e ativadas, decisões de roteamento, buscas de
 * conhecimento, transições do funil e custo — e devolve tudo agregado.
 *
 * Auth: sessão por cookie, papel manager+. `organization_id` sai do JWT.
 * Usamos o client com escopo de usuário para a RLS valer; o filtro explícito de
 * `organization_id` é defesa em profundidade exigida pela convenção do repo.
 *
 * Só há busca de dados aqui — a agregação mora em `lib/ai/evolution/aggregate.ts`
 * (pura e testável). Duas armadilhas do transporte são responsabilidade DESTE
 * arquivo, e estão marcadas onde acontecem: o client PostgREST (não um pool `pg`
 * cru, que entregaria `timestamptz` como `Date` e quebraria o `.slice(0, 10)` do
 * agregador) e a coerção de `numeric` para `number`.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import type { SupabaseClient } from "@supabase/supabase-js";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { ok, fail } from "@/lib/api/wrappers";
import {
  aggregateEvolution,
  type EvolutionInput,
  type FonteIncompleta,
} from "@/lib/ai/evolution/aggregate";
import { usoDeIaSchema } from "@/lib/ai/usage/aggregate";
import { traduzir } from "@/lib/i18n/dicionario";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";

export const dynamic = "force-dynamic";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 90;
/**
 * O teto de cada leitura é o `max_rows` do PostgREST (`supabase/config.toml`):
 * 1.000. Pedir mais não traz mais — o servidor corta antes. Com 50.000 aqui,
 * `rows.length === ROW_CAP` nunca era verdade e o aviso de corte nunca disparava
 * (#5016). O corte agora é medido pelo `count` exato que volta junto com as
 * linhas (vale também para instalação com `max_rows` menor); o teto só é a régua
 * quando o `count` não vem.
 */
const ROW_CAP = 1_000;

const querySchema = z.object({
  from: z.string().regex(DAY_RE).optional(),
  to: z.string().regex(DAY_RE).optional(),
});

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function endOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
}
function parseDayUtc(s: string): Date {
  return new Date(`${s}T00:00:00.000Z`);
}

function resolveRange(qs: { from?: string; to?: string }): { from: Date; to: Date } {
  const now = new Date();
  const to = qs.to ? parseDayUtc(qs.to) : startOfUtcDay(now);
  let from = qs.from ? parseDayUtc(qs.from) : startOfUtcDay(new Date(now.getTime() - 29 * 86_400_000));
  const diffDays = Math.round((to.getTime() - from.getTime()) / 86_400_000);
  if (diffDays > MAX_RANGE_DAYS - 1) from = new Date(to.getTime() - (MAX_RANGE_DAYS - 1) * 86_400_000);
  if (from.getTime() > to.getTime()) from = to;
  return { from: startOfUtcDay(from), to: startOfUtcDay(to) };
}

/**
 * A página veio menor que o total? Com `count`, é a conta exata; sem ele (o
 * PostgREST não devolveu), a única régua é ter batido o teto pedido.
 */
function veioCortada(linhas: number, count: number | null | undefined): boolean {
  // `Content-Range: 0-999/*` chega do cliente como `NaN`: não é total nenhum.
  if (typeof count === "number" && Number.isFinite(count)) return count > linhas;
  return linhas >= ROW_CAP;
}

/**
 * Funil declarado (passo do agente por pipeline) NO TOKEN. A sessão usa o embed
 * `crm_pipelines!inner` de sempre; a service role não passa pela RLS da tabela de
 * dentro, então aqui o nome do funil vem de consulta própria filtrada pela
 * organização, e o passo é ligado ao funil em memória, na mesma forma.
 */
type LinhaDoFunil = { agent_stage_hint: string | null; crm_pipelines: { name: string } };

async function lerFunilDoToken(
  db: SupabaseClient,
  orgId: string,
): Promise<{
  data: LinhaDoFunil[] | null;
  error: { message: string } | null;
  count?: number | null;
  funisCortados?: boolean;
}> {
  const { data: funis, error: errFunis, count: totalDeFunis } = await db
    .from("crm_pipelines")
    .select("id, name", { count: "exact" })
    .eq("organization_id", orgId);
  if (errFunis) return { data: null, error: errFunis };
  const nomePorFunil = new Map(
    ((funis ?? []) as Array<{ id: string; name: string }>).map((f) => [f.id, f.name] as const),
  );
  // Lista de funis cortada: as etapas de 2ª consulta só cobrem os funis lidos, e o
  // `count` delas sozinho diria "completo". O corte da 1ª consulta vai junto.
  const funisCortados = veioCortada((funis ?? []).length, totalDeFunis);
  if (nomePorFunil.size === 0) return { data: [], error: null, count: 0, funisCortados };

  const { data: etapas, error: errEtapas, count } = await db
    .from("crm_stages")
    .select("agent_stage_hint, pipeline_id", { count: "exact" })
    .eq("organization_id", orgId)
    .in("pipeline_id", [...nomePorFunil.keys()])
    .eq("is_archived", false)
    .limit(ROW_CAP);
  if (errEtapas) return { data: null, error: errEtapas };

  const linhas = ((etapas ?? []) as Array<{ agent_stage_hint: string | null; pipeline_id: string }>).flatMap(
    (e): LinhaDoFunil[] => {
      const name = nomePorFunil.get(e.pipeline_id);
      return name === undefined ? [] : [{ agent_stage_hint: e.agent_stage_hint, crm_pipelines: { name } }];
    },
  );
  // `count` das etapas, como no embed da sessão: é ele que diz se a página veio
  // cortada. O `.in` acima só traz etapas de funis lidos, então cada etapa vira
  // uma linha e o tamanho da página é o mesmo.
  return { data: linhas, error: null, count, funisCortados };
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "ai_evolution",
    role: "manager",
    scope: "config:read",
    tokenRole: "admin",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "ai_evolution", requestId);
  if (teto) return teto;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);
  const orgId = authz.organizationId;

  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams.entries()));
  if (!parsed.success) {
    return fail("validation_failed", t("Filtros inválidos."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const range = resolveRange(parsed.data);
  const fromIso = range.from.toISOString();
  const toIso = endOfUtcDay(range.to).toISOString();
  const supabase = authz.supabase;

  /**
   * Uma fonte fora do ar não pode apagar o painel inteiro: o bloco dela aparece
   * zerado e os outros continuam contando a história. Log com `requestId` e nome
   * da tabela — sem os dois, a fonte muda vira um bloco zerado indistinguível de
   * "não aconteceu nada".
   */
  /**
   * O que a TELA fica sabendo (#5016): cada fonte cortada pelo teto ou que
   * falhou. Antes isso só ia para o log, e o bloco mostrava o recorte (ou o
   * zero) com cara de número exato. Uma entrada por tabela.
   */
  const fontesIncompletas: FonteIncompleta[] = [];
  function marcarIncompleta(fonte: string, motivo: FonteIncompleta["motivo"]): void {
    if (!fontesIncompletas.some((f) => f.fonte === fonte)) fontesIncompletas.push({ fonte, motivo });
  }

  function fonteFalhou(tabela: string, error: { message: string }, motivo: FonteIncompleta["motivo"] = "falhou"): void {
    console.warn(`[ai-evolution] leitura de ${tabela} falhou`, {
      requestId,
      table: tabela,
      error: error.message,
    });
    marcarIncompleta(tabela, motivo);
  }

  /**
   * Base de TODA leitura: a org do JWT e a MESMA janela que vai em `input.range`.
   * O agregador monta as séries diárias sobre os dias do range mas conta os totais
   * sobre o que receber — linha fora da janela sumiria do gráfico e continuaria no
   * card, duas respostas diferentes para a mesma pergunta na mesma tela.
   */
  function janela(tabela: string, colunas: string, colunaData: string, apenasContagem = false) {
    // `count: "exact"` também nas leituras de linha: é o que diz se a página veio
    // inteira (#5016). Sem ele, "1.000 linhas" não distingue "o período tem 1.000"
    // de "o servidor parou em 1.000".
    return supabase
      .from(tabela)
      .select(colunas, apenasContagem ? { count: "exact", head: true } : { count: "exact" })
      .eq("organization_id", orgId)
      .gte(colunaData, fromIso)
      .lte(colunaData, toIso);
  }

  async function ler<T>(tabela: string, colunas: string, colunaData: string): Promise<T[]> {
    // `order` antes do `limit`: sem ele, QUAIS linhas voltam ao bater o teto é
    // indefinido — as séries diárias viram amostra arbitrária e o custo
    // sub-relata, tudo com cara de número exato. Ordenar pela mesma coluna que já
    // está no predicado sai de graça nas duas tabelas quentes
    // (`idx_llm_calls_org_time`, `idx_ai_router_decisions_org_created`); nas
    // outras o volume é pequeno.
    const { data, error, count } = await janela(tabela, colunas, colunaData)
      .order(colunaData, { ascending: true })
      .limit(ROW_CAP);
    if (error) {
      fonteFalhou(tabela, error);
      return [];
    }
    const rows = (data ?? []) as T[];
    // Página menor que o total: o painel está mostrando um RECORTE, não o
    // período. Reaproveita o canal de aviso em vez de calar — número truncado sem
    // sinal é pior que bloco zerado, porque parece completo.
    if (veioCortada(rows.length, count)) {
      fonteFalhou(tabela, { message: `row cap de ${ROW_CAP} atingido — período truncado` }, "cortada");
    }
    return rows;
  }

  /**
   * Contagem sem trazer linha: `head: true` devolve só o `count`. Contar o tamanho
   * da página daria o teto de `ROW_CAP` como resposta — uma taxa distorcida.
   */
  async function contar(tabela: string, colunaData: string, extraEq: [string, string]): Promise<number> {
    const { count, error } = await janela(tabela, "id", colunaData, true).eq(extraEq[0], extraEq[1]);
    if (error) {
      fonteFalhou(tabela, error);
      return 0;
    }
    // Sem `count` e sem erro não é "zero": é "não sei". Zero calado viraria a
    // taxa de ajuda (ou o "não houve atendimento") com cara de fato.
    if (typeof count !== "number" || !Number.isFinite(count)) {
      fonteFalhou(tabela, { message: "contagem veio sem count" });
      return 0;
    }
    return count;
  }

  /**
   * O custo é SOMADO NO BANCO (#5016), pela mesma `fn_uso_de_ia` e a mesma janela
   * da tela Uso de IA (`usage/route.ts`). Somar `llm_calls` aqui parava na
   * milésima linha do período (o `max_rows`), e como a leitura é em ordem
   * crescente, o card mostrava o custo dos dias MAIS ANTIGOS. `security invoker`:
   * a RLS continua isolando a organização; `p_org` é defesa em profundidade.
   * Falhou: o card zera e a tela é avisada, como qualquer outra fonte.
   */
  async function custoDoPeriodo(): Promise<number> {
    const { data, error } = await supabase.rpc("fn_uso_de_ia", {
      p_org: orgId,
      p_desde: fromIso,
      p_ate: toIso,
    });
    if (error) {
      fonteFalhou("llm_calls", error);
      return 0;
    }
    // `usoDeIaSchema` coage `numeric` (que pode chegar como string) para número —
    // e coagiria `null` para 0 também. O custo é o número do card: só vale se
    // veio um número de verdade; o resto é falha, nunca um zero calado.
    const bruto = (data as { totais?: { custo_cents?: unknown } } | null)?.totais?.custo_cents;
    const custoValido =
      (typeof bruto === "number" || (typeof bruto === "string" && bruto.trim() !== "")) &&
      Number.isFinite(Number(bruto));
    const uso = usoDeIaSchema.safeParse(data);
    if (!uso.success || !custoValido) {
      fonteFalhou("llm_calls", { message: "fn_uso_de_ia devolveu formato inesperado" });
      return 0;
    }
    return uso.data.totais.custo_cents;
  }

  const [
    memoryEntries,
    proposalsApplied,
    skillInstalls,
    skillActivations,
    routerDecisions,
    knowledgeSearches,
    stageTransitions,
    costCents,
    inboundCount,
    handoffInbox,
    handoffEvents,
    stages,
  ] = await Promise.all([
    ler<{ created_at: string; title: string }>("org_memory_entries", "created_at, title", "created_at"),
    // `applied_at` é nulo enquanto a proposta não foi aplicada, e `NULL` não
    // satisfaz `gte`/`lte` — a própria janela já deixa só as aplicadas de fora.
    ler<{ applied_at: string; type: string; content: string }>(
      "flywheel_distiller_proposals",
      "applied_at, type, content",
      "applied_at",
    ),
    // Skills instaladas no período: os ponteiros da PRÓPRIA org (o catálogo de
    // plataforma tem `organization_id` nulo e não é instalação do tenant — o
    // filtro de org já o exclui). A tabela não tem `created_at`; `updated_at` É o
    // momento em que o ponteiro se moveu, ou seja, a instalação/atualização.
    ler<{ updated_at: string; name: string }>("skill_pointers", "updated_at, name", "updated_at"),
    ler<{ created_at: string; skill_name: string }>("skill_activations", "created_at, skill_name", "created_at"),
    // `router_id` vai junto: nulo é o turno de um número SEM roteador (#4340),
    // que `aggregateEvolution` deixa fora de todas as contas.
    ler<{ created_at: string; outcome: string; intent_name: string | null; router_id: string | null }>(
      "ai_router_decisions",
      "created_at, outcome, intent_name, router_id",
      "created_at",
    ),
    ler<{ created_at: string; hits: number; top_score: number | null; threshold: number; author_kind: string }>(
      "knowledge_searches",
      "created_at, hits, top_score, threshold, author_kind",
      "created_at",
    ),
    ler<{ created_at: string; to_stage: string }>("lead_state_transitions", "created_at, to_stage", "created_at"),
    custoDoPeriodo(),
    contar("messages", "created_at", ["direction", "inbound"]),
    // ⚠️ DUAS FONTES DE HANDOFF, DE PROPÓSITO — não "simplifique" para uma.
    // Há dois runtimes no repo e cada um registra o handoff no seu lugar:
    //   • agent-engine (canônico desde a Fase 0, o mesmo que produz as outras
    //     fontes deste painel) grava `agent_inbox_items(kind='handoff')` e NÃO
    //     escreve em `event_log` — ver `lib/agent-engine/agent/human-handoff.ts`;
    //   • runtime nativo antigo emite `event_log('ai.handoff_triggered')` — ver
    //     `lib/ai/handoff/orchestrator.ts` e `lib/mcp/tools/handoff.ts`.
    // Contar só o `event_log` daria 0% de handoff para todo tenant no agent-engine
    // — "sua IA nunca precisa de ajuda", a mentira mais lisonjeira que este painel
    // poderia contar. Somar não duplica: um turno passa por um runtime OU pelo
    // outro, nunca pelos dois.
    contar("agent_inbox_items", "created_at", ["kind", "handoff"]),
    contar("event_log", "created_at", ["event_type", "ai.handoff_triggered"]),
    // Mapeamento declarado do funil: quais passos do agente cada pipeline recebe.
    // Sem janela de data — é o estado ATUAL do funil, não um evento do período.
    authz.via === "token"
      ? lerFunilDoToken(supabase, orgId)
      : supabase
          .from("crm_stages")
          .select("agent_stage_hint, crm_pipelines!inner(name)", { count: "exact" })
          .eq("organization_id", orgId)
          .eq("crm_pipelines.organization_id", orgId)
          .eq("is_archived", false)
          .limit(ROW_CAP),
  ]);

  if (stages.error) fonteFalhou("crm_stages", stages.error);
  else if (
    ("funisCortados" in stages && stages.funisCortados) ||
    veioCortada((stages.data ?? []).length, stages.count)
  ) {
    fonteFalhou("crm_stages", { message: `row cap de ${ROW_CAP} atingido — funis truncados` }, "cortada");
  }

  const porPipeline = new Map<string, Array<string | null>>();
  for (const r of (stages.data ?? []) as Array<{
    agent_stage_hint: string | null;
    crm_pipelines: { name: string } | { name: string }[];
  }>) {
    const p = Array.isArray(r.crm_pipelines) ? r.crm_pipelines[0] : r.crm_pipelines;
    if (!p) continue;
    const lista = porPipeline.get(p.name) ?? [];
    lista.push(r.agent_stage_hint);
    porPipeline.set(p.name, lista);
  }

  const input: EvolutionInput = {
    range,
    memoryEntries,
    proposalsApplied,
    skillInstalls,
    skillActivations,
    routerDecisions,
    knowledgeSearches,
    stageTransitions,
    // Já é número: `usoDeIaSchema` coage o `numeric` (ver `custoDoPeriodo`).
    costCents,
    inboundCount,
    handoffCount: handoffInbox + handoffEvents,
    pipelines: [...porPipeline.entries()].map(([name, hints]) => ({ name, hints })),
    fontesIncompletas,
  };

  return ok(aggregateEvolution(input), { requestId });
}
