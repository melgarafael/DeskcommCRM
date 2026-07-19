/**
 * GET/POST /api/v1/cron/agent-dispatcher
 *
 * Vercel cron entry point for the AI agent dispatcher (S-13.07, Spec 10 §5).
 * Each invocation drains up to 100 `ai_agent.dispatch_requested` rows from
 * `event_log`, picks the top-priority published agent for each, and fires the
 * runner via `/api/internal/agents/run`.
 *
 * Auth: header `Authorization: Bearer <INTERNAL_CRON_SECRET>` (preferred) or
 * `<INTERNAL_SECRET>` (fallback for parity with other internal crons). The
 * X-Cron-Secret header from Spec 10 §5.1 is also accepted as alias so the
 * spec wording stays valid.
 *
 * Schedule (vercel.ts): one tick per minute (Vercel cap). Spec asks for
 * 5s polling, but Vercel does not support sub-minute crons; processing 100
 * events per tick gives ~6k events/hour headroom which exceeds the MVP
 * target tenant of ~300 inbound/day across all conversations.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { env } from "@/lib/env";
import { audit } from "@/lib/audit";
import { dispatchAgents } from "@/lib/ai/dispatcher";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const headerSecret = req.headers.get("x-cron-secret")?.trim() ?? "";
  const provided = bearer || headerSecret;

  const cronSecret = env.INTERNAL_CRON_SECRET;
  const fallbackSecret = env.INTERNAL_SECRET;
  const accepted: string[] = [];
  if (cronSecret) accepted.push(cronSecret);
  if (fallbackSecret) accepted.push(fallbackSecret);

  if (accepted.length === 0 || !provided || !accepted.includes(provided)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  // Fusão (Fase 4): com o agent-engine como dono do dispatch, este cron é
  // NO-OP mecânico — dois consumidores dos mesmos eventos = turno duplicado
  // ou perdido. O worker (drain) é o único consumidor quando
  // AGENT_DISPATCH_CONSUMER='engine' (default do produto fundido).
  if (env.AGENT_DISPATCH_CONSUMER === "engine") {
    return ok({ skipped: true, reason: "dispatch_owned_by_agent_engine" }, { requestId });
  }

  let summary;
  try {
    summary = await dispatchAgents();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("[agent-dispatcher.cron] dispatchAgents threw", { error: detail, requestId });
    return fail("internal_error", detail, 500, { requestId });
  }

  // Single audit row per tick — aggregate counts. Skipping per-event audit to
  // stay within the p99 ≤500ms budget; per-run audit happens in S-13.08 once
  // the runner persists `ai_agent_runs.status` transitions.
  await audit({
    action: "ai.dispatcher_run",
    organizationId: null,
    metadata: {
      batch_size: summary.batch_size,
      outcomes: summary.outcomes,
      errors: summary.errors.length,
    },
    requestId,
  });

  return ok(
    {
      batch_size: summary.batch_size,
      outcomes: summary.outcomes,
      errors: summary.errors,
    },
    { requestId, meta: { requestId } },
  );
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
