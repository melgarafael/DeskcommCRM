/**
 * GET/POST /api/v1/cron/followup-flow-worker — Onda 4 (Task 4.2) + Onda 8
 * (Task 8.1, gatilho de silêncio).
 *
 * Drena os enrollments due de `followup_enrollments` via `runFollowupTick`
 * (lib/followup/engine.ts) — o motor único de relógio do sistema de
 * follow-up. Trigger Postgres NUNCA faz HTTP; este cron TS é quem consome via
 * admin client, no mesmo contrato dos demais crons.
 *
 * Depois do tick, `runSilenceSweep` (lib/followup/silence-sweep.ts) NO MESMO
 * tick — gatilho TIME-DRIVEN (varredura periódica, não event-driven): acha
 * pointers `trigger_config.kind='silence'` ativos, decide o agente pelo grafo
 * (`decidirAgenteDoEnrollmentAutomatico`: texto fixo segue sem agente; nó de
 * IA exige agente publicado armando o pointer), acha contatos silenciosos e
 * cria enrollment. Falha do sweep NUNCA aborta a resposta do tick (try/catch
 * isolado, só loga) — o cron sempre devolve o resultado de `runFollowupTick`.
 *
 * No fim, drena texto fixo pendente (`enviarTextoFixoPendente`) — o mesmo
 * atalho do relógio HTTP. Onde não há `agent-worker` (instalação sem o
 * contêiner `worker`), sem isto o job `followup_turn` fica `pending` e o
 * no_reply nunca vira mensagem. O ledger (job_id, seq) impede envio em dobro no
 * self-host, onde o worker também consome a fila.
 *
 * Auth: Bearer INTERNAL_CRON_SECRET|INTERNAL_SECRET, fail-closed. Audit
 * agregada por tick (`followup.worker_run` + `followup.silence_sweep_run`),
 * sem organization_id (roda pra todas as orgs).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { createSupabaseAdminClient, runFollowupTick, type FollowupJobRequest } from "@/lib/followup/engine";
import { createSupabaseFollowupGateDb } from "@/lib/followup/agent-followup-gate";
import { enviarTextoFixoPendente } from "@/lib/followup/enviar-texto-fixo";
import { encerrarRoteirosVencidos } from "@/lib/followup/atendimento";
import { createSupabaseSilenceSweepDb, runSilenceSweep } from "@/lib/followup/silence-sweep";
import { autorizaCron } from "@/lib/auth/cron-auth";

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

  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const admin = createAdminClient();
  const deps = {
    db: createSupabaseAdminClient(admin),
    clock: () => new Date(),
    enqueueJob,
  };

  const confirmation=await admin.rpc("fn_appointment_confirmation_sweep",{});
  if(confirmation.error) return fail("internal_error","Não foi possível verificar as confirmações de presença.",500,{requestId});
  if(Number(confirmation.data)>0) void audit({action:"agenda.confirmation_sweep_run",organizationId:null,bypassedRls:true,requestId,metadata:{avisos:Number(confirmation.data)}});
  let summary;
  try {
    summary = await runFollowupTick(deps);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("[followup-flow-worker.cron] runFollowupTick threw", { error: detail, requestId });
    return fail("internal_error", detail, 500, { requestId });
  }

  // Só audita tick que MEXEU em alguma coisa. Auditar toda batida enchia o
  // api_audit_log — que é append-only e tem retenção de 5 anos — de linhas
  // vazias: numa instalação parada, medido nesta VPS, 95% das entradas eram
  // heartbeat de cron (1.175 de 1.236 em ~9h), afogando as ações reais na tela
  // de auditoria. Liveness de worker é assunto de log/monitoramento, não de
  // trilha de auditoria.
  //
  // `claim_falhou` entra na condição porque é o ÚNICO caso em que todos os
  // contadores são zero e ainda assim algo aconteceu: o claim não chegou ao
  // banco. Sem esta cláusula o tick que falhou é idêntico, na trilha, ao tick de
  // uma instalação sem nada a fazer.
  //
  // O emissor NUNCA foi o buraco: `claim_falhou` e o `logger.error` existem em
  // `runFollowupTick` desde f66f0ddb, com teste. O que faltava era o outro lado
  // — anti-pattern 3 do CLAUDE.md, evento sem consumer: o campo criado para
  // separar "o banco não respondeu" de "não havia nada a fazer" era emitido e
  // ninguém o lia. Quem vier depois precisa saber onde estava o defeito, senão
  // vai procurar no lugar que já estava certo.
  if (
    summary.claim_falhou ||
    summary.claimed ||
    summary.advanced ||
    summary.scheduled ||
    summary.failed ||
    summary.dead
  ) {
    void audit({
      action: "followup.worker_run",
      organizationId: null,
      bypassedRls: true,
      metadata: { ...summary },
      requestId,
    });
  }

  try {
    const sweepSummary = await runSilenceSweep({
      db: createSupabaseSilenceSweepDb(admin),
      gateDb: createSupabaseFollowupGateDb(admin),
      clock: () => new Date(),
    });
    if (sweepSummary.enrolled || sweepSummary.pointers_gated_out || sweepSummary.skipped_existing) {
      void audit({
        action: "followup.silence_sweep_run",
        organizationId: null,
        bypassedRls: true,
        metadata: { ...sweepSummary },
        requestId,
      });
    }
  } catch (err) {
    // Sweep falhando NUNCA aborta o tick — a resposta abaixo já reflete o
    // resultado de runFollowupTick, que rodou (e foi auditado) antes disto.
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("[followup-flow-worker.cron] runSilenceSweep threw", { error: detail, requestId });
  }

  // Roteiro de atendimento com o prazo vencido (0397). Audita só quando houve
  // efeito — rodada que não encerrou nada não é mutação.
  try {
    const expirados = await encerrarRoteirosVencidos(admin);
    if (expirados > 0) {
      void audit({
        action: "followup.roteiros_expirados",
        organizationId: null,
        bypassedRls: true,
        metadata: { expirados },
        requestId,
      });
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("[followup-flow-worker.cron] encerrarRoteirosVencidos threw", { error: detail, requestId });
  }

  // ponytail: instalação sem `agent-worker` (relógio HTTP, cron puro) não tem
  // quem consuma a fila. Sem este dreno o no_reply avança o grafo e a mensagem
  // seguinte fica pending. Teto: jobs sem fixed_body (mode ai_message) continuam
  // precisando do worker.
  try {
    await enviarTextoFixoPendente(admin);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("[followup-flow-worker.cron] enviarTextoFixoPendente threw", { error: detail, requestId });
  }

  return ok(summary, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
