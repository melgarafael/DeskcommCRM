/**
 * GET/POST /api/v1/cron/event-log-drain
 *
 * Vercel cron entry point for the generic event_log drain (Task 2, spec
 * webhooks/automação 2026-07-17). Each tick drains up to 50 `pending` rows
 * whose `event_type` has a handler registered via `ensureHandlersRegistered()`
 * — types drained by a dedicated cron (e.g. `ai_agent.dispatch_requested` →
 * agent-dispatcher) have no handler here and are left untouched.
 *
 * Auth: header `Authorization: Bearer <INTERNAL_CRON_SECRET>` (preferred) or
 * `<INTERNAL_SECRET>` (fallback), same pattern as agent-dispatcher. The
 * X-Cron-Secret header is also accepted as alias.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { drainEventLog } from "@/lib/event-log/drain";
import { ensureHandlersRegistered } from "@/lib/event-log/register-handlers";
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

  ensureHandlersRegistered();
  try {
    const summary = await drainEventLog(createAdminClient());
    return ok(summary, { requestId });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("[event-log-drain.cron] threw", { error: detail, requestId });
    return fail("internal_error", detail, 500, { requestId });
  }
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
