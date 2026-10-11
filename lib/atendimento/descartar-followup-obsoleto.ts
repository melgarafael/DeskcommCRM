import type { Pool } from "pg";
import { logger } from "@/lib/logger";
import type { Logger } from "@/lib/agent-engine/obs/logger";
import { claimOfJob } from "@/lib/agent-engine/queue/claim";
import { cancelJob, type JobRow } from "@/lib/agent-engine/queue/queue";

/** Descartar o turno não cancela a inscrição: pause/cancel continuam sendo
 * decisões do fluxo. O rastro permite retomar sem falso worker morto.
 * Só o worker (sem auth.uid de uma sessão) chama esta função.
 */
export async function descartarFollowupObsoleto(
  pool: Pool,
  job: JobRow,
  workerId: string,
  log: Pick<Logger, "warn"> = logger,
): Promise<void> {
  const claim = claimOfJob(job);
  if (!claim || job.kind !== "followup_turn") return;
  const tx = await pool.connect();
  try {
    await tx.query("begin");
    const { rows } = await tx.query(
      `select id from job_queue where organization_id=$1 and id=$2
         and kind='followup_turn' and status='running' and locked_by=$3
         and locked_at=$4::timestamptz for update`,
      [job.organization_id, job.id, workerId, claim.acquired_at],
    );
    if (rows.length) {
      await tx.query(
        `select fn_followup_turno_descartado($1,$2) where public.fn_autonomous_turn_revoked($1,$2)`,
        [job.organization_id, job.id],
      );
      await cancelJob(tx, job.id, workerId, "service_boundary_stale", claim.acquired_at);
    } else {
      // Não registra descarte nem altera o lease que já pertence a outro ciclo.
      log.warn("followup_stale_discard_lease_changed", {
        job_id: job.id, organization_id: job.organization_id, kind: job.kind,
      });
    }
    await tx.query("commit");
  } catch (error) {
    await tx.query("rollback");
    throw error;
  } finally {
    tx.release();
  }
}
