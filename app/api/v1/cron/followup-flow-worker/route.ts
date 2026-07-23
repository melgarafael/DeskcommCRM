/**
 * GET/POST /api/v1/cron/followup-flow-worker — Onda 4 (Task 4.2) + Onda 8
 * (Task 8.1, gatilho de silêncio).
 *
 * Drena os enrollments due de `followup_enrollments` via `runFollowupTick`
 * (lib/followup/engine.ts) — o motor único de relógio do sistema de
 * follow-up. Trigger Postgres NUNCA faz HTTP; este cron TS é quem consome via
 * admin client, no mesmo contrato dos demais crons.
 *
 * Depois do tick, roda `runSilenceSweep` (lib/followup/silence-sweep.ts) NO
 * MESMO tick — gatilho TIME-DRIVEN (varredura periódica, não event-driven):
 * acha pointers `trigger_config.kind='silence'` ativos, gateia via
 * `isPointerEnabledForAutomaticTrigger` (só enrolla se algum agente publicado
 * da org tem o pointer habilitado), acha contatos silenciosos e cria
 * enrollment. Falha do sweep NUNCA aborta a resposta do tick (try/catch
 * isolado, só loga) — o cron sempre devolve o resultado de `runFollowupTick`.
 *
 * Auth: Bearer INTERNAL_CRON_SECRET|INTERNAL_SECRET, fail-closed. Audit
 * agregada por tick (`followup.worker_run` + `followup.silence_sweep_run`),
 * sem organization_id (roda pra todas as orgs).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { createSupabaseAdminClient, runFollowupTick, type FollowupJobRequest } from "@/lib/followup/engine";
import { createSupabaseFollowupGateDb } from "@/lib/followup/agent-followup-gate";
import { createSupabaseSilenceSweepDb, runSilenceSweep } from "@/lib/followup/silence-sweep";

export const dynamic = "force-dynamic";

/** Insere o job followup_turn na fila existente (migration 0050) — consumido
 *  pelo handler já pronto em lib/agent-engine/agent/followup-turn.ts. */
async function enqueueJob(job: FollowupJobRequest): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from("job_queue").insert({
    organization_id: job.organization_id,
    contact_id: job.contact_id,
    kind: "followup_turn",
    payload: job.payload,
  });
  if (error) throw new Error(error.message);
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const provided = bearer || (req.headers.get("x-cron-secret")?.trim() ?? "");
  const accepted = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  if (accepted.length === 0 || !provided || !accepted.includes(provided)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const admin = createAdminClient();
  const deps = {
    db: createSupabaseAdminClient(admin),
    clock: () => new Date(),
    enqueueJob,
  };

  let summary;
  try {
    summary = await runFollowupTick(deps);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("[followup-flow-worker.cron] runFollowupTick threw", { error: detail, requestId });
    return fail("internal_error", detail, 500, { requestId });
  }

  void audit({
    action: "followup.worker_run",
    organizationId: null,
    bypassedRls: true,
    metadata: { ...summary },
    requestId,
  });

  try {
    const sweepSummary = await runSilenceSweep({
      db: createSupabaseSilenceSweepDb(admin),
      gateDb: createSupabaseFollowupGateDb(admin),
      clock: () => new Date(),
    });
    void audit({
      action: "followup.silence_sweep_run",
      organizationId: null,
      bypassedRls: true,
      metadata: { ...sweepSummary },
      requestId,
    });
  } catch (err) {
    // Sweep falhando NUNCA aborta o tick — a resposta abaixo já reflete o
    // resultado de runFollowupTick, que rodou (e foi auditado) antes disto.
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("[followup-flow-worker.cron] runSilenceSweep threw", { error: detail, requestId });
  }

  return ok(summary, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
