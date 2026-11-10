/**
 * GET/POST /api/v1/cron/cadencia-worker — anda a fila de `email_cadence_enrollments`
 * vencidas, minuto a minuto (mesma cadência do `campaign-worker`, agendado em
 * `docker/scheduler/entrypoint.sh`).
 *
 * A regra vive em `lib/cadencias/worker.ts` (`processarCadencias`), separada
 * daqui pelo mesmo motivo de `recover-stuck-messages`: o teste exercita a
 * regra sem montar request/auth, e esta rota fica sendo só borda.
 *
 * Auth: mesmo contrato dos demais crons (Bearer INTERNAL_CRON_SECRET|
 * INTERNAL_SECRET, fail-closed).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { processarCadencias } from "@/lib/cadencias/worker";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  let resultado;
  try {
    resultado = await processarCadencias(createAdminClient(), new Date(), requestId);
  } catch {
    logger.error("[cadencia-worker] rodada falhou", { codigo: "cadencia_tick_failed", requestId });
    return fail("internal_error", "Failed to process cadencia enrollments.", 500, { requestId });
  }

  // Rodada que não mexeu em nenhuma inscrição não é mutação e não audita —
  // mesmo critério do `recover-stuck-messages`/`data-retention` (CLAUDE.md,
  // seção de audit log).
  if (resultado.processadas > 0) {
    void audit({
      action: "cron.cadencia_worker",
      organizationId: null,
      bypassedRls: true,
      metadata: resultado as unknown as Record<string, unknown>,
      requestId,
    });
  }

  return ok(resultado, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
