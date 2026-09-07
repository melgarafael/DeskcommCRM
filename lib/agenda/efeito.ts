import type { JobClaim } from "@/lib/agent-engine/queue/claim";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AgendaDeferredError, protecaoAgendaPg, protecaoAgendaSupabase } from "./protecao-followup";
import { StaleServiceBoundaryError } from "@/lib/atendimento/fronteira";

/** Somente contexto interno: não é aceito pelo schema de mensagens/tools. */
export interface ProactiveContext {
  organizationId: string;
  contactId: string;
  enrollmentId?: string;
  nodeId?: string;
  jobId?: string;
  jobClaim?: JobClaim;
}
const effects = new AsyncLocalStorage<{ db: Queryable; context: ProactiveContext }>();
export async function assertAgendaEffectPg(db: Queryable, c: ProactiveContext): Promise<void> {
  if (c.jobId) {
    if (!c.jobClaim) throw new StaleServiceBoundaryError();
    const { rows } = await db.query<{ current: boolean }>(
      "select fn_followup_claim_current($1,$2,$3,$4) as current",
      [c.organizationId, c.jobId, c.jobClaim.worker_id, c.jobClaim.acquired_at],
    );
    if (!rows[0]?.current) throw new StaleServiceBoundaryError();
  }
  if (c.enrollmentId && c.jobId) {
    const { rows } = await db.query<{ current: boolean }>(
      "select fn_followup_job_current($1,$2,$3,$4) as current",
      [c.organizationId, c.jobId, c.enrollmentId, c.nodeId ?? null],
    );
    if (!rows[0]?.current) throw new StaleServiceBoundaryError();
  }
  if (c.enrollmentId) {
    const { rows } = await db.query<{ current: boolean }>(
      "select fn_appointment_enrollment_current($1,$2,$3) as current",
      [c.organizationId, c.enrollmentId, c.nodeId ?? null],
    );
    if (!rows[0]?.current) throw new StaleServiceBoundaryError();
  }
  const p = await protecaoAgendaPg(db, c.organizationId, c.contactId);
  if (p.adiar) throw new AgendaDeferredError(p);
}
export async function assertAgendaEffectSupabase(
  db: SupabaseClient,
  c: ProactiveContext,
): Promise<void> {
  if (c.jobId) {
    if (!c.jobClaim) throw new StaleServiceBoundaryError();
    const { data, error } = await db.rpc("fn_followup_claim_current", {
      p_org: c.organizationId,
      p_job: c.jobId,
      p_worker: c.jobClaim.worker_id,
      p_acquired_at: c.jobClaim.acquired_at,
    });
    if (error) throw error;
    if (!data) throw new StaleServiceBoundaryError();
  }
  if (c.enrollmentId && c.jobId) {
    const { data, error } = await db.rpc("fn_followup_job_current", {
      p_org: c.organizationId,
      p_job: c.jobId,
      p_enrollment: c.enrollmentId,
      p_node: c.nodeId ?? null,
    });
    if (error) throw error;
    if (!data) throw new StaleServiceBoundaryError();
  }
  if (c.enrollmentId) {
    const { data, error } = await db.rpc("fn_appointment_enrollment_current", {
      p_org: c.organizationId,
      p_id: c.enrollmentId,
      p_node: c.nodeId ?? null,
    });
    if (error) throw error;
    if (!data) throw new StaleServiceBoundaryError();
  }
  const p = (await protecaoAgendaSupabase(db, c.organizationId, [c.contactId])).get(c.contactId)!;
  if (p.adiar) throw new AgendaDeferredError(p);
}
export async function guardAgendaEffect(): Promise<void> {
  const scope = effects.getStore();
  if (scope) await assertAgendaEffectPg(scope.db, scope.context);
}
export async function withAgendaEffect<T>(
  db: Queryable,
  context: ProactiveContext,
  action: () => Promise<T>,
): Promise<T> {
  await assertAgendaEffectPg(db, context);
  return effects.run({ db, context }, action);
}
