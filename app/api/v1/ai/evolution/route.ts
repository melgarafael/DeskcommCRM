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

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { aggregateEvolution, type EvolutionInput } from "@/lib/ai/evolution/aggregate";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 90;
const ROW_CAP = 50_000;

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

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const authz = await requireRole("manager", { requestId, resource: "ai_evolution" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

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
  const supabase = await createClient();

  /**
   * Uma fonte fora do ar não pode apagar o painel inteiro: o bloco dela aparece
   * zerado e os outros continuam contando a história. Log com `requestId` e nome
   * da tabela — sem os dois, a fonte muda vira um bloco zerado indistinguível de
   * "não aconteceu nada".
   */
  function fonteFalhou(tabela: string, error: { message: string }): void {
    console.warn(`[ai-evolution] leitura de ${tabela} falhou`, {
      requestId,
      table: tabela,
      error: error.message,
    });
  }

  /**
   * Base de TODA leitura: a org do JWT e a MESMA janela que vai em `input.range`.
   * O agregador monta as séries diárias sobre os dias do range mas conta os totais
   * sobre o que receber — linha fora da janela sumiria do gráfico e continuaria no
   * card, duas respostas diferentes para a mesma pergunta na mesma tela.
   */
  function janela(tabela: string, colunas: string, colunaData: string, apenasContagem = false) {
    return supabase
      .from(tabela)
      .select(colunas, apenasContagem ? { count: "exact", head: true } : undefined)
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
    const { data, error } = await janela(tabela, colunas, colunaData)
      .order(colunaData, { ascending: true })
      .limit(ROW_CAP);
    if (error) {
      fonteFalhou(tabela, error);
      return [];
    }
    const rows = (data ?? []) as T[];
    // Teto batido: o painel está mostrando um RECORTE, não o período. Reaproveita
    // o canal de aviso em vez de calar — número truncado sem sinal é pior que
    // bloco zerado, porque parece completo.
    if (rows.length === ROW_CAP) {
      fonteFalhou(tabela, { message: `row cap de ${ROW_CAP} atingido — período truncado` });
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
    return count ?? 0;
  }

  const [
    memoryEntries,
    proposalsApplied,
    skillInstalls,
    skillActivations,
    routerDecisions,
    knowledgeSearches,
    stageTransitions,
    llmCalls,
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
    ler<{ created_at: string; outcome: string; intent_name: string | null }>(
      "ai_router_decisions",
      "created_at, outcome, intent_name",
      "created_at",
    ),
    ler<{ created_at: string; hits: number; top_score: number | null; threshold: number }>(
      "knowledge_searches",
      "created_at, hits, top_score, threshold",
      "created_at",
    ),
    ler<{ created_at: string; to_stage: string }>("lead_state_transitions", "created_at, to_stage", "created_at"),
    ler<{ cost_cents: number | null }>("llm_calls", "cost_cents", "created_at"),
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
    supabase
      .from("crm_stages")
      .select("agent_stage_hint, crm_pipelines!inner(name)")
      .eq("organization_id", orgId)
      .eq("crm_pipelines.organization_id", orgId)
      .eq("is_archived", false)
      .limit(ROW_CAP),
  ]);

  if (stages.error) fonteFalhou("crm_stages", stages.error);

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
    // ⚠️ COERÇÃO OBRIGATÓRIA. `cost_cents` é `numeric`, e o agregador repassa este
    // total sem tocar nele. Se uma linha vier como string, `acc + '12.5'` concatena
    // em silêncio e o card mostra texto (ou NaN) — nunca um erro.
    costCents: llmCalls.reduce((acc, c) => acc + Number(c.cost_cents ?? 0), 0),
    inboundCount,
    handoffCount: handoffInbox + handoffEvents,
    pipelines: [...porPipeline.entries()].map(([name, hints]) => ({ name, hints })),
  };

  return ok(aggregateEvolution(input), { requestId });
}
