import type { JobRow } from "./queue";
/** Instante textual devolvido pelo UPDATE de claim, preservando microssegundos. */
export interface JobClaim {
  worker_id: string;
  acquired_at: string;
}
export function claimOfJob(
  job: Pick<JobRow, "locked_by" | "claim_acquired_at">,
): JobClaim | undefined {
  return job.locked_by && job.claim_acquired_at
    ? { worker_id: job.locked_by, acquired_at: job.claim_acquired_at }
    : undefined;
}
