/**
 * GET/POST /api/v1/cron/routing-worker — G5-02 (AT-03, spec 13 §5).
 *
 * Drena `conversation.routing_requested` do event_log e distribui conversas sem
 * dono segundo o modo da org (manual = no-op; round_robin = rodízio entre
 * elegíveis). Trigger NUNCA faz HTTP — a emissão é um trigger AFTER INSERT em
 * conversations (migration 0040); este cron TS consome via admin client.
 *
 * Auth: mesmo contrato dos demais crons (Bearer INTERNAL_CRON_SECRET|
 * INTERNAL_SECRET, fail-closed). Audit agregada por tick.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { runRoutingWorker } from "@/lib/routing/worker";

export const dynamic = "force-dynamic";

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const provided = bearer || (req.headers.get("x-cron-secret")?.trim() ?? "");
  const accepted = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  if (accepted.length === 0 || !provided || !accepted.includes(provided)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  let summary;
  try {
    summary = await runRoutingWorker();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("[routing-worker.cron] runRoutingWorker threw", { error: detail, requestId });
    return fail("internal_error", detail, 500, { requestId });
  }

  void audit({
    action: "routing.worker_run",
    organizationId: null,
    bypassedRls: true,
    metadata: { batch_size: summary.batch_size, outcomes: summary.outcomes, errors: summary.errors.length },
    requestId,
  });

  return ok(
    { batch_size: summary.batch_size, outcomes: summary.outcomes, errors: summary.errors },
    { requestId },
  );
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
