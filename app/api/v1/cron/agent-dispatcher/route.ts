/**
 * GET/POST /api/v1/cron/agent-dispatcher
 *
 * @deprecated Fase 0 (convergência, spec 2026-07-23): o dispatch nativo
 * (S-13.07, Spec 10 §5) foi aposentado — o agent-worker (drain) é o único
 * consumidor de `ai_agent.dispatch_requested`. Esta rota é NO-OP permanente,
 * mantida apenas para não quebrar cron configs existentes de self-hosters.
 *
 * Auth: header `Authorization: Bearer <INTERNAL_CRON_SECRET>` (preferred) or
 * `<INTERNAL_SECRET>` (fallback for parity with other internal crons). The
 * X-Cron-Secret header from Spec 10 §5.1 is also accepted as alias so the
 * spec wording stays valid.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { autorizaCron } from "@/lib/auth/cron-auth";

export const dynamic = "force-dynamic";

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  // Fase 0 (convergência, spec 2026-07-23): o dispatch nativo foi aposentado —
  // o agent-worker (drain) é o único consumidor de ai_agent.dispatch_requested.
  // A rota permanece para não quebrar cron configs existentes.
  return ok({ skipped: true, deprecated: true, reason: "native dispatcher retired (Fase 0)" }, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
