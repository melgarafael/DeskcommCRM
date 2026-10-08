import type { Pool } from "pg";
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
        `select fn_followup_turno_descartado($1,$2) where exists (
        select 1 from event_log where organization_id=$1 and entity_id=$2
          and entity_kind='job' and event_type='conversation.autonomous_turn_revoked' and status='done')`,
        [job.organization_id, job.id],
      );
      await cancelJob(tx, job.id, workerId, "service_boundary_stale", claim.acquired_at);
    }
    await tx.query("commit");
  } catch (error) {
    await tx.query("rollback");
    throw error;
  } finally {
    tx.release();
  }
}
