/**
 * GET /api/v1/ai/usage — observability dashboard for AI invocations.
 *
 * Aggregates `ai_invocations` (cost, tokens, latency p50/p95, count) per day,
 * plus a per-day handoff rate (handoffs from `event_log` / inbound messages).
 *
 * Auth: cookie session, role manager+. organization_id resolved from JWT.
 *
 * Aggregation is done in TypeScript (see `lib/ai/usage/aggregate.ts`) so this
 * stays portable and unit-testable. We use the user-scoped client so RLS
 * enforces tenant isolation; the explicit organization_id filter is defense
 * in depth and required by repo convention.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { aggregateUsage, type InvocationRow } from "@/lib/ai/usage/aggregate";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 90;

const querySchema = z.object({
  agent_id: z.string().uuid().optional(),
  invocation_kind: z.string().min(1).max(64).optional(),
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

  // Hard-cap range to MAX_RANGE_DAYS.
  const diffDays = Math.round((to.getTime() - from.getTime()) / 86_400_000);
  if (diffDays > MAX_RANGE_DAYS - 1) {
    from = new Date(to.getTime() - (MAX_RANGE_DAYS - 1) * 86_400_000);
  }
  if (from.getTime() > to.getTime()) {
    from = to;
  }
  return { from: startOfUtcDay(from), to: startOfUtcDay(to) };
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const authz = await requireRole("manager", { requestId, resource: "ai_usage" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org: activeOrg } = authz;

  const parsed = querySchema.safeParse(
    Object.fromEntries(req.nextUrl.searchParams.entries()),
  );
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

  // ---- 1. llm_calls: a ÚNICA tabela de telemetria (migration 0130) ---------
  //
  // Antes eram duas — `ai_invocations` (workers legados) e `llm_calls`
  // (agent-engine) — e esta rota somava as duas. O remendo consertava a tela e
  // deixava a raiz: toda leitura nova precisava lembrar das duas, e a que
  // esquecesse mentia (foi assim que esta tela mostrou ZERO custo com o
  // dinheiro saindo). A 0130 fez o backfill; `ai_invocations` é histórico e
  // ninguém mais escreve nela.
  let invQ = supabase
    .from("llm_calls")
    .select("created_at, purpose, cost_cents, input_tokens, output_tokens, latency_ms, agent_id")
    .eq("organization_id", activeOrg.orgId)
    .gte("created_at", fromIso)
    .lte("created_at", toIso)
    .order("created_at", { ascending: true })
    .limit(50_000);

  // O filtro por agente continua existindo: a 0130 levou `agent_id` para
  // `llm_calls` justamente para a unificação não custar essa capacidade — é
  // como o operador descobre QUAL agente está consumindo a conta.
  if (parsed.data.agent_id) invQ = invQ.eq("agent_id", parsed.data.agent_id);
  if (parsed.data.invocation_kind) invQ = invQ.eq("purpose", parsed.data.invocation_kind);

  const { data: invRowsRaw, error: invErr } = await invQ;
  if (invErr) {
    console.warn("[ai-usage] llm_calls query failed", { error: invErr.message });
    return fail("internal_error", "Erro ao agregar o uso de IA.", 500, { requestId });
  }
  const invRows = ((invRowsRaw ?? []) as unknown as Array<{
    created_at: string; purpose: string | null; cost_cents: number | null;
    input_tokens: number | null; output_tokens: number | null; latency_ms: number | null;
  }>).map((r) => ({
    created_at: r.created_at,
    invocation_kind: r.purpose ?? "turno",
    cost_cents: r.cost_cents,
    prompt_tokens: r.input_tokens,
    completion_tokens: r.output_tokens,
    total_tokens: (r.input_tokens ?? 0) + (r.output_tokens ?? 0),
    latency_ms: r.latency_ms,
  }));

  // ---- 2. inbound messages per day ----------------------------------------
  const dailyInbounds = new Map<string, number>();
  const { data: inboundRows, error: inboundErr } = await supabase
    .from("messages")
    .select("created_at")
    .eq("organization_id", activeOrg.orgId)
    .eq("direction", "inbound")
    .gte("created_at", fromIso)
    .lte("created_at", toIso)
    .limit(100_000);
  if (inboundErr) {
    console.warn("[ai-usage] inbound messages query failed", { error: inboundErr.message });
  } else {
    for (const r of inboundRows ?? []) {
      const day = (r as { created_at: string }).created_at.slice(0, 10);
      dailyInbounds.set(day, (dailyInbounds.get(day) ?? 0) + 1);
    }
  }

  // ---- 3. handoffs per day (event_log: ai.handoff_triggered) --------------
  const dailyHandoffs = new Map<string, number>();
  const { data: handoffRows, error: handoffErr } = await supabase
    .from("event_log")
    .select("created_at")
    .eq("organization_id", activeOrg.orgId)
    .eq("event_type", "ai.handoff_triggered")
    .gte("created_at", fromIso)
    .lte("created_at", toIso)
    .limit(100_000);
  if (handoffErr) {
    console.warn("[ai-usage] handoff events query failed", { error: handoffErr.message });
  } else {
    for (const r of handoffRows ?? []) {
      const day = (r as { created_at: string }).created_at.slice(0, 10);
      dailyHandoffs.set(day, (dailyHandoffs.get(day) ?? 0) + 1);
    }
  }

  // O bloco que somava `llm_calls` a `ai_invocations` foi REMOVIDO aqui, e a
  // remoção é a parte perigosa desta mudança: com a leitura primária já sendo
  // `llm_calls` (migration 0130), mantê-lo faria a MESMA linha ser contada duas
  // vezes — o custo do mês dobraria na tela, e o teto de orçamento passaria a
  // disparar na metade do gasto real. Guardado por
  // `tests/unit/usage-nao-conta-em-dobro.test.ts`.

  const payload = aggregateUsage(
    invRows as InvocationRow[],
    dailyInbounds,
    dailyHandoffs,
    range,
  );

  return ok(payload, { requestId });
}
