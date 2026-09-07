import { z } from "zod";
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import type { JobClaim } from "@/lib/agent-engine/queue/claim";
import type { SupabaseClient } from "@supabase/supabase-js";
import { StaleServiceBoundaryError } from "@/lib/atendimento/fronteira";
/** Internal capability reference; never accepted by public message schemas. */
export interface ApprovedReplyContext {
  organizationId: string;
  jobId: string;
  jobClaim: JobClaim;
}
const schema = z.object({
  current: z.literal(true),
  context_current: z.boolean(),
  contact_id: z.uuid(),
  conversation_id: z.uuid(),
  channel_session_id: z.uuid(),
  draft_id: z.uuid(),
  body: z.string(),
  agent_id: z.uuid(),
});
function policy(raw: unknown, receipt: boolean) {
  const p = schema.safeParse(raw);
  if (!p.success || (!receipt && !p.data.context_current)) throw new StaleServiceBoundaryError();
  return p.data;
}
export async function assertApprovedReplyPg(db: Queryable, c: ApprovedReplyContext) {
  return policy(await read(db, c), false);
}
export async function assertApprovedReplyReceiptPg(db: Queryable, c: ApprovedReplyContext) {
  const { rows } = await db.query("select fn_reply_receipt_policy($1,$2,$3,$4) policy", [
    c.organizationId,
    c.jobId,
    c.jobClaim.worker_id,
    c.jobClaim.acquired_at,
  ]);
  return policy(rows[0]?.policy, true);
}
export async function assertApprovedReplyReceiptSupabase(
  db: SupabaseClient,
  c: ApprovedReplyContext,
) {
  const { data, error } = await db.rpc("fn_reply_receipt_policy", {
    p_org: c.organizationId,
    p_job: c.jobId,
    p_worker: c.jobClaim.worker_id,
    p_acquired_at: c.jobClaim.acquired_at,
  });
  if (error) throw error;
  return policy(data, true);
}

async function read(db: Queryable, c: ApprovedReplyContext) {
  const { rows } = await db.query("select fn_reply_delivery_policy($1,$2,$3,$4) as policy", [
    c.organizationId,
    c.jobId,
    c.jobClaim.worker_id,
    c.jobClaim.acquired_at,
  ]);
  return rows[0]?.policy;
}
export async function assertApprovedReplySupabase(db: SupabaseClient, c: ApprovedReplyContext) {
  const { data, error } = await db.rpc("fn_reply_delivery_policy", {
    p_org: c.organizationId,
    p_job: c.jobId,
    p_worker: c.jobClaim.worker_id,
    p_acquired_at: c.jobClaim.acquired_at,
  });
  if (error) throw error;
  return policy(data, false);
}
export async function prepareApprovedReplySupabase(db: SupabaseClient, c: ApprovedReplyContext) {
  const { data, error } = await db.rpc("fn_reply_prepare", {
    p_org: c.organizationId,
    p_job: c.jobId,
    p_worker: c.jobClaim.worker_id,
    p_acquired_at: c.jobClaim.acquired_at,
  });
  if (error) throw error;
  if (data !== true) throw new StaleServiceBoundaryError();
}

/** Provider accepted; persistence may have committed even when its response was lost. */
export class ApprovedReplyReceiptPersistenceError extends Error {
  constructor(cause: unknown) {
    super("approved_reply_receipt_persistence_uncertain", { cause });
  }
}

export async function recordApprovedReplyReceiptSupabase(
  db: SupabaseClient,
  c: ApprovedReplyContext,
  messageId: string,
  externalId: string | null,
  echoIds: string[],
) {
  let result;
  try {
    result = await db.rpc("fn_reply_record_receipt", {
      p_org: c.organizationId,
      p_job: c.jobId,
      p_worker: c.jobClaim.worker_id,
      p_acquired_at: c.jobClaim.acquired_at,
      p_message: messageId,
      p_external: externalId,
      p_echo_ids: echoIds,
    });
  } catch (error) {
    throw new ApprovedReplyReceiptPersistenceError(error);
  }
  const { data, error } = result;
  if (error) throw new ApprovedReplyReceiptPersistenceError(error);
  if (!data) throw new StaleServiceBoundaryError();
  return data;
}
