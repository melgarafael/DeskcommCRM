import { z } from "zod";
import { decidirElegibilidade, montarEstadoDeElegibilidade, ttlDaAutorizacaoMs } from "@/lib/ai/elegibilidade/gate";
import type { ServiceBoundary } from "@/lib/atendimento/fronteira";
import type { JobClaim } from "@/lib/agent-engine/queue/claim";
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import type { SupabaseClient } from "@supabase/supabase-js";
import { StaleServiceBoundaryError } from "@/lib/atendimento/fronteira";

/** Contexto interno, nunca campo aceito pelo schema público de mensagem. */
export interface MeetingDeliveryContext {
  organizationId: string;
  jobId: string;
  jobClaim: JobClaim;
}
export class MeetingDeliveryBlockedError extends Error {
  constructor(readonly reason: string) { super("meet_delivery_blocked"); }
}
const policySchema = z.discriminatedUnion("current", [
  z.object({ current: z.literal(false), reason: z.string() }),
  z.object({ current: z.literal(true), human_command: z.boolean(), contact_id: z.uuid(), channel_session_id: z.uuid(),
    force_human: z.boolean().nullable(), ai_gate: z.string().nullable(),
    ai_authorized_at: z.string().nullable(), assignee_kind: z.string().nullable(), bot_silenced_until: z.string().nullable(),
  }),
]);
function requireCurrentPolicy(raw: unknown) {
  const p = policySchema.parse(raw);
  if (!p.current) {
    if (!p.reason || p.reason === "stale") throw new StaleServiceBoundaryError();
    throw new MeetingDeliveryBlockedError(p.reason);
  }
  return p;
}
function requirePolicy(raw: unknown): { humanCommand: boolean; contactId: string; channelSessionId: string } {
  const p = requireCurrentPolicy(raw);
  if (p.human_command === true) return { humanCommand: true, contactId: p.contact_id, channelSessionId: p.channel_session_id };
  const result = decidirElegibilidade(montarEstadoDeElegibilidade({
    aiGate: p.ai_gate, forceHuman: p.force_human, assigneeKind: p.assignee_kind ?? null,
    botSilencedUntil: p.bot_silenced_until, aiAuthorizedAt: p.ai_authorized_at,
    agora: new Date(), ttlMs: ttlDaAutorizacaoMs(process.env),
  }));
  if (!result.permite) throw new MeetingDeliveryBlockedError(result.motivo);
  return { humanCommand: false, contactId: p.contact_id, channelSessionId: p.channel_session_id };
}
/** Só reconhecimento de recibo: não autoriza transporte, mas conserva dados,
 * intenção, atendimento e aquisição originais pelo mesmo predicado do settle. */
export async function assertMeetingDeliveryReceiptPg(db: Queryable, c: MeetingDeliveryContext): Promise<void> {
  requireCurrentPolicy(await readMeetingPolicyPg(db, c));
}
async function readMeetingPolicyPg(db: Queryable, c: MeetingDeliveryContext): Promise<unknown> {
  const { rows } = await db.query<{ policy: unknown }>(
    "select fn_meet_delivery_policy($1,$2,$3,$4) as policy",
    [c.organizationId, c.jobId, c.jobClaim.worker_id, c.jobClaim.acquired_at],
  );
  return rows[0]?.policy;
}
export async function assertMeetingDeliveryPg(db: Queryable, c: MeetingDeliveryContext) {
  return requirePolicy(await readMeetingPolicyPg(db, c));
}
export async function assertMeetingDeliverySupabase(db: SupabaseClient, c: MeetingDeliveryContext) {
  const { data, error } = await db.rpc("fn_meet_delivery_policy", {
    p_org: c.organizationId, p_job: c.jobId, p_worker: c.jobClaim.worker_id,
    p_acquired_at: c.jobClaim.acquired_at,
  });
  if (error) throw error;
  return requirePolicy(data);
}

export interface MeetingBookingContext {
  sourceJobId: string;
  claim: JobClaim;
  boundary: ServiceBoundary;
}
