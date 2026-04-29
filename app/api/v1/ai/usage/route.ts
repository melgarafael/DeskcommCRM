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
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";
import { aggregateUsage, type InvocationRow } from "@/lib/ai/usage/aggregate";

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

  const authUser = await loadAuthUser();
  if (!authUser) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) {
    return fail("forbidden", "Nenhuma organização ativa.", 403, { requestId });
  }
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    return fail("forbidden_role", "Permissão insuficiente. Requer role >= manager.", 403, {
      requestId,
    });
  }

  const parsed = querySchema.safeParse(
    Object.fromEntries(req.nextUrl.searchParams.entries()),
  );
  if (!parsed.success) {
    return fail("validation_failed", "Filtros inválidos.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const range = resolveRange(parsed.data);
  const fromIso = range.from.toISOString();
  const toIso = endOfUtcDay(range.to).toISOString();

  const supabase = await createClient();

  // ---- 1. ai_invocations rows for the range/filters ------------------------
  let invQ = supabase
    .from("ai_invocations")
    .select(
      "created_at, invocation_kind, cost_cents, prompt_tokens, completion_tokens, total_tokens, latency_ms",
    )
    .eq("organization_id", activeOrg.orgId)
    .gte("created_at", fromIso)
    .lte("created_at", toIso)
    .order("created_at", { ascending: true })
    .limit(50_000);

  if (parsed.data.agent_id) invQ = invQ.eq("agent_id", parsed.data.agent_id);
  if (parsed.data.invocation_kind) invQ = invQ.eq("invocation_kind", parsed.data.invocation_kind);

  const { data: invRows, error: invErr } = await invQ;
  if (invErr) {
    console.warn("[ai-usage] ai_invocations query failed", { error: invErr.message });
    return fail("internal_error", "Erro ao agregar invocations.", 500, { requestId });
  }

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

  const payload = aggregateUsage(
    (invRows ?? []) as InvocationRow[],
    dailyInbounds,
    dailyHandoffs,
    range,
  );

  return ok(payload, { requestId });
}
