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
import { autorizaCron } from "@/lib/auth/cron-auth";
import { logger } from "@/lib/logger";
import { runRoutingWorker } from "@/lib/routing/worker";

export const dynamic = "force-dynamic";

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!autorizaCron(req)) {
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

  // Tick que não drenou evento nenhum não é mutação e não ocupa linha de
  // auditoria (mesmo critério do snooze-watcher, do followup-flow-worker e do
  // recover-stuck-messages). Esta rota roda 1×/min: auditar incondicionalmente
  // gravava 43.200 linhas/mês numa instalação que não atende ninguém, numa
  // tabela append-only com retenção de anos — 95% do audit log de uma VPS real
  // era batida de cron vazia (`docs/testing/user-journey-map.md`, achado 17).
  //
  // `errors` entra na condição e NÃO é redundante com `batch_size`: quando o
  // `select` do event_log falha, `runRoutingWorker` devolve `batch_size = 0` com
  // o erro dentro (worker.ts:88). Sem esta cláusula, o tick em que o banco não
  // respondeu ficaria idêntico, na trilha, ao tick de uma instalação sem nada a
  // fazer — o mesmo defeito que `claim_falhou` conserta no followup-flow-worker.
  if (summary.batch_size > 0 || summary.errors.length > 0) {
    void audit({
      action: "routing.worker_run",
      organizationId: null,
      bypassedRls: true,
      metadata: {
        batch_size: summary.batch_size,
        outcomes: summary.outcomes,
        errors: summary.errors.length,
      },
      requestId,
    });
  }

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
