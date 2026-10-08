import type { Queryable } from "../queue/queue";
import type { SupabaseClient } from "@supabase/supabase-js";

export class PaymentReviewPendingError extends Error {
  constructor() {
    super("payment_review_pending");
    this.name = "PaymentReviewPendingError";
  }
}

/** Dados duráveis da conversa; comprovante nunca equivale a recebimento confirmado. */
export async function paymentReviewPending(
  db: Queryable,
  organizationId: string,
  conversationId: string,
  leadId?: string | null,
): Promise<boolean> {
  const { rows } = await db.query<{ pending: boolean }>(
    `select exists(select 1 from agent_cases where organization_id=$1 and conversation_id=$2
       and task_kind='payment_review' and task_state <> 'completed'
       and status in ('awaiting_human','awaiting_lead')
       and ($3::uuid is null or lead_id=$3::uuid)) as pending`,
    [organizationId, conversationId, leadId ?? null],
  );
  return rows[0]?.pending === true;
}

export async function paymentReviewPendingSupabase(
  db: SupabaseClient,
  organizationId: string,
  conversationId: string,
  leadId?: string | null,
): Promise<boolean> {
  let query = db
    .from("agent_cases")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("conversation_id", conversationId)
    .eq("task_kind", "payment_review")
    .neq("task_state", "completed")
    .in("status", ["awaiting_human", "awaiting_lead"]);
  if (leadId) query = query.eq("lead_id", leadId);
  const { data, error } = await query.limit(1);
  if (error) throw new Error(error.message);
  return (data?.length ?? 0) > 0;
}

export async function assertNoPaymentReview(
  db: Queryable,
  organizationId: string,
  conversationId: string,
  leadId?: string | null,
): Promise<void> {
  if (await paymentReviewPending(db, organizationId, conversationId, leadId))
    throw new PaymentReviewPendingError();
}

export async function sendUnlessPaymentReview<T>(
  db: Queryable,
  ids: { organizationId: string; conversationId: string; jobKind: string; leadId?: string | null },
  send: () => Promise<T>,
): Promise<T> {
  if (ids.jobKind === "followup_turn")
    await assertNoPaymentReview(db, ids.organizationId, ids.conversationId, ids.leadId);
  return send();
}
