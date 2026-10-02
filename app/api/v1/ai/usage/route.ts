/**
 * GET /api/v1/ai/usage — observability dashboard for AI invocations.
 *
 * Aggregates `llm_calls` (cost, tokens, cache, latency p50/p95, calls, agent
 * turns) per day, plus a per-day handoff rate (handoffs from `event_log` /
 * inbound messages) — all summed in Postgres by `fn_uso_de_ia` (migration 0523).
 *
 * Auth: cookie session, role manager+. organization_id resolved from JWT.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { montarPayloadDeUso, usoDeIaSchema } from "@/lib/ai/usage/aggregate";
import { logger } from "@/lib/logger";
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

  // A soma é feita NO BANCO (`fn_uso_de_ia`, migration 0523). Esta rota buscava
  // as linhas de `llm_calls` e somava aqui — e o PostgREST entrega no máximo
  // `max_rows` (1000) linhas: passada a milésima chamada do período, os dias
  // mais recentes sumiam. A função lê só `llm_calls`, a ÚNICA tabela de
  // telemetria desde a 0130 — somar `ai_invocations` junto contaria a mesma
  // linha duas vezes (`tests/unit/usage-nao-conta-em-dobro.test.ts`).
  //
  // Cliente da sessão: a função é `security invoker`, então a RLS continua
  // isolando a organização; `p_org` é defesa em profundidade.
  const { data, error } = await supabase.rpc("fn_uso_de_ia", {
    p_org: activeOrg.orgId,
    p_desde: fromIso,
    p_ate: toIso,
    // O filtro por agente continua existindo: a 0130 levou `agent_id` para
    // `llm_calls` justamente para a unificação não custar essa capacidade.
    p_agent_id: parsed.data.agent_id,
    p_purpose: parsed.data.invocation_kind,
  });
  if (error) {
    logger.warn("ai_usage.rpc_falhou", { requestId, error: error.message });
    return fail("internal_error", t("Erro ao agregar o uso de IA."), 500, { requestId });
  }
  const uso = usoDeIaSchema.safeParse(data);
  if (!uso.success) {
    logger.warn("ai_usage.formato_inesperado", { requestId, issues: uso.error.issues.length });
    return fail("internal_error", t("Erro ao agregar o uso de IA."), 500, { requestId });
  }

  const payload = montarPayloadDeUso(uso.data, range);

  return ok(payload, { requestId });
}
