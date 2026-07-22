/**
 * Follow-up flow engine — worker tick (Task 4.1). Orchestrates DB access
 * around the pure decisions in `node-handlers.ts`: claim due enrollments,
 * load the pinned graph + lead facts, run `processNode`, persist the result.
 *
 * `AdminClient` is a narrow interface (not `SupabaseClient` directly) so this
 * file is testable against the bare-Postgres harness used by
 * `tests/invariants/**` (no PostgREST there — see `pg-admin-client.ts` for
 * the pg-backed adapter used by the DB test) as well as production, where
 * `createSupabaseAdminClient` below adapts the real service-role client.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { flowGraphSchema, type FlowGraph, type FlowNode } from "./graph-schema";
import {
  BACKOFF_MS,
  processNode,
  resolveWaitPhase,
  type EnrollmentEventRef,
  type EnrollmentOutcome,
  type EnrollmentRow,
  type EnrollmentStatus,
  type LeadFacts,
  type NodeResult,
} from "./node-handlers";

const MAX_STEPS = 30;
const ACTION_RECHECK_MS = 5 * 60_000;
const CLAIM_LEASE_SECONDS = 120;
const DEFAULT_CLAIM_LIMIT = 20;
const MAX_ERROR_LEN = 300;

export interface EnrollmentPatch {
  status?: EnrollmentStatus;
  current_node_id?: string;
  next_eval_at?: string | null;
  claimed_until?: string | null;
  attempts?: number;
  last_error?: string | null;
  steps_taken?: number;
  outcome?: EnrollmentOutcome | null;
  cancel_reason?: string | null;
  completed_at?: string | null;
  updated_at?: string;
}

export interface FollowupJobRequest {
  organization_id: string;
  contact_id: string;
  payload: {
    followup_enrollment_id: string;
    node_id: string;
    purpose: "send_message" | "classify" | "decide_timing";
  };
}

/** DB surface the engine needs — see file header for why this isn't `SupabaseClient` directly. */
export interface AdminClient {
  claimDueEnrollments(limit: number, leaseSeconds: number): Promise<EnrollmentRow[]>;
  loadFlowGraph(orgId: string, versionId: string): Promise<FlowGraph | null>;
  loadLeadFacts(orgId: string, contactId: string): Promise<{ lead_stage: string | null; tags: string[] }>;
  loadEnrollmentEvents(enrollmentId: string): Promise<EnrollmentEventRef[]>;
  /** Inserts the step's audit event; `inserted:false` means idempotency_key already existed (23505 replay). */
  insertEnrollmentEvent(event: {
    organization_id: string;
    enrollment_id: string;
    node_id: string;
    event_type: string;
    payload: Record<string, unknown>;
    idempotency_key: string;
  }): Promise<{ inserted: boolean }>;
  updateEnrollment(id: string, orgId: string, patch: EnrollmentPatch): Promise<void>;
  loadFlowPointerName(orgId: string, pointerId: string): Promise<string | null>;
  insertDeadInboxItem(item: { organization_id: string; title: string; body: string; ref_id: string }): Promise<void>;
}

export interface TickDeps {
  db: AdminClient;
  clock: () => Date;
  enqueueJob: (job: FollowupJobRequest) => Promise<void>;
}

export interface TickSummary {
  claimed: number;
  advanced: number;
  scheduled: number;
  failed: number;
  dead: number;
}

function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // last_error nunca carrega PII — mensagens são strings de código controladas
  // pelo próprio engine; o truncamento é só cinto de segurança contra erro
  // inesperado de driver/DB verboso.
  return raw.slice(0, MAX_ERROR_LEN);
}

function eventTypeFor(result: NodeResult): string {
  switch (result.kind) {
    case "advance":
      return "node_advanced";
    case "wait":
      return "wait_started";
    case "enqueue_turn":
      return result.purpose === "classify" ? "classify_enqueued" : "turn_enqueued";
    case "complete":
      return "flow_completed";
    case "fail":
      return "node_failed";
  }
}

function eventPayload(result: NodeResult): Record<string, unknown> {
  switch (result.kind) {
    case "advance":
      return { next_node_id: result.next_node_id };
    case "wait":
      return { next_eval_at: result.next_eval_at.toISOString() };
    case "enqueue_turn":
      return { purpose: result.purpose, wake_status: result.wake_status };
    case "complete":
      return { outcome: result.outcome, cancel_reason: result.cancel_reason ?? null };
    case "fail":
      return { error: result.error };
  }
}

async function markDead(
  db: AdminClient,
  clock: () => Date,
  enrollment: EnrollmentRow,
  reason: string,
  attempts?: number,
): Promise<void> {
  const sanitized = errorMessage(reason);

  // Ordem deliberada: inbox ANTES do status='dead'. Se cair no meio (crash /
  // DB soluço entre as duas escritas), o enrollment continua com status
  // active/waiting_reply — ainda claimable — então um tick futuro re-executa
  // markDead do zero. Pior caso é um item de inbox duplicado (visível, o
  // usuário só vê o aviso 2x); a ordem inversa arriscaria o pior caso real:
  // status='dead' gravado e o aviso NUNCA sair — enrollment morto em
  // silêncio. Duplicata visível > perda silenciosa.
  const flowName = (await db.loadFlowPointerName(enrollment.organization_id, enrollment.pointer_id)) ?? enrollment.pointer_id;
  await db.insertDeadInboxItem({
    organization_id: enrollment.organization_id,
    title: "Um fluxo de follow-up parou de tentar",
    body: `O fluxo "${flowName}" (enrollment ${enrollment.id}) foi marcado como "dead": ${sanitized}`,
    ref_id: enrollment.id,
  });

  await db.updateEnrollment(enrollment.id, enrollment.organization_id, {
    ...(attempts !== undefined ? { attempts } : {}),
    status: "dead",
    cancel_reason: sanitized,
    last_error: sanitized,
    next_eval_at: null,
    claimed_until: null,
    completed_at: clock().toISOString(),
    updated_at: clock().toISOString(),
  });
}

async function applyHandlerFailure(
  deps: Pick<TickDeps, "db" | "clock">,
  enrollment: EnrollmentRow,
  rawError: string,
  summary: TickSummary,
): Promise<void> {
  const { db, clock } = deps;
  summary.failed++;

  const attempts = enrollment.attempts + 1;
  if (attempts > enrollment.max_attempts) {
    await markDead(db, clock, enrollment, rawError, attempts);
    summary.dead++;
    return;
  }

  const backoffMs = BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)]!;
  await db.updateEnrollment(enrollment.id, enrollment.organization_id, {
    attempts,
    last_error: errorMessage(rawError),
    next_eval_at: new Date(clock().getTime() + backoffMs).toISOString(),
    claimed_until: null,
    updated_at: clock().toISOString(),
  });
}

function tallyOutcome(result: NodeResult, summary: TickSummary): void {
  if (result.kind === "advance" || result.kind === "complete") {
    summary.advanced++;
  } else if (result.kind === "wait" || result.kind === "enqueue_turn") {
    summary.scheduled++;
  }
}

async function applyResult(
  deps: TickDeps,
  enrollment: EnrollmentRow,
  node: FlowNode,
  result: NodeResult,
  summary: TickSummary,
): Promise<void> {
  const { db, clock, enqueueJob } = deps;

  if (result.kind === "fail") {
    await applyHandlerFailure(deps, enrollment, result.error, summary);
    return;
  }

  const idemKey = `${node.id}:${enrollment.steps_taken}`;
  const { inserted } = await db.insertEnrollmentEvent({
    organization_id: enrollment.organization_id,
    enrollment_id: enrollment.id,
    node_id: node.id,
    event_type: eventTypeFor(result),
    payload: eventPayload(result),
    idempotency_key: idemKey,
  });
  const isReplay = !inserted;

  const patch: EnrollmentPatch = {
    steps_taken: enrollment.steps_taken + 1,
    claimed_until: null,
    updated_at: clock().toISOString(),
  };

  switch (result.kind) {
    case "advance":
      patch.current_node_id = result.next_node_id;
      patch.status = "active";
      patch.next_eval_at = result.next_eval_at.toISOString();
      break;
    case "wait":
      patch.current_node_id = enrollment.current_node_id;
      patch.status = "active";
      patch.next_eval_at = result.next_eval_at.toISOString();
      break;
    case "enqueue_turn": {
      patch.current_node_id = enrollment.current_node_id;
      patch.status = result.wake_status;
      // node.type narrado (union discriminada de FlowNode) — sem cast: dentro
      // do `if`, node.config já é o config do ai_classify de verdade.
      const graceMs =
        result.purpose === "classify" && node.type === "ai_classify"
          ? node.config.grace_timeout_ms
          : ACTION_RECHECK_MS;
      patch.next_eval_at = new Date(clock().getTime() + graceMs).toISOString();
      if (!isReplay) {
        // At-most-once: o job só é disparado na aplicação FRESCA do resultado —
        // um replay (23505) nunca reenfileira turno (doutrina de envio). Se
        // enqueueJob falhar aqui (rede/fila fora do ar), o evento JÁ foi
        // commitado — updateEnrollment abaixo não roda nesta tentativa, então
        // o enrollment continua claimable e o tick seguinte reprocessa o
        // MESMO passo: o insert do evento bate 23505 (replay), enqueueJob é
        // pulado de novo (nunca reenvia) e o enrollment converge pro
        // next_eval_at normal (5min ação / grace do classify). Efeito líquido
        // de uma falha transitória no enqueue: atraso limitado ao próximo
        // recheck, nunca um envio duplicado — self-healing, sem retry
        // agressivo de envio.
        await enqueueJob({
          organization_id: enrollment.organization_id,
          contact_id: enrollment.contact_id,
          payload: { followup_enrollment_id: enrollment.id, node_id: node.id, purpose: result.purpose },
        });
      }
      break;
    }
    case "complete":
      patch.current_node_id = enrollment.current_node_id;
      patch.status = "completed";
      patch.next_eval_at = null;
      patch.completed_at = clock().toISOString();
      patch.outcome = result.outcome;
      if (result.cancel_reason) patch.cancel_reason = result.cancel_reason;
      break;
  }

  await db.updateEnrollment(enrollment.id, enrollment.organization_id, patch);

  if (!isReplay) tallyOutcome(result, summary);
}

async function processEnrollment(deps: TickDeps, enrollment: EnrollmentRow, summary: TickSummary): Promise<void> {
  const { db, clock } = deps;

  if (enrollment.steps_taken > MAX_STEPS) {
    await markDead(db, clock, enrollment, "max_steps");
    summary.dead++;
    return;
  }

  const graph = await db.loadFlowGraph(enrollment.organization_id, enrollment.version_id);
  if (!graph) throw new Error("flow_version_not_found");

  const node = graph.nodes.find((n) => n.id === enrollment.current_node_id);
  if (!node) throw new Error("node_not_found");

  const leadRow = await db.loadLeadFacts(enrollment.organization_id, enrollment.contact_id);
  const lead: LeadFacts = {
    lead_stage: leadRow.lead_stage,
    tags: leadRow.tags,
    steps_taken: enrollment.steps_taken,
    last_outcome: null, // onda 5: ai_classify ainda não persiste resultado pra condicionar
  };

  let waitElapsed: boolean | undefined;
  if (node.type === "wait") {
    const events = await db.loadEnrollmentEvents(enrollment.id);
    waitElapsed = resolveWaitPhase(events, node.id, enrollment.steps_taken);
  }

  const result = processNode({ node, edges: graph.edges, enrollment, lead, clock, waitElapsed });
  await applyResult(deps, enrollment, node, result, summary);
}

export async function runFollowupTick(deps: TickDeps, opts?: { limit?: number }): Promise<TickSummary> {
  const summary: TickSummary = { claimed: 0, advanced: 0, scheduled: 0, failed: 0, dead: 0 };

  let claimed: EnrollmentRow[];
  try {
    claimed = await deps.db.claimDueEnrollments(opts?.limit ?? DEFAULT_CLAIM_LIMIT, CLAIM_LEASE_SECONDS);
  } catch {
    // claim falhando é infra (DB fora do ar) — o tick seguinte tenta de novo; nunca lança.
    return summary;
  }
  summary.claimed = claimed.length;

  for (const enrollment of claimed) {
    try {
      await processEnrollment(deps, enrollment, summary);
    } catch (err) {
      try {
        // Nunca deixa uma falha de UM enrollment derrubar o tick inteiro.
        await applyHandlerFailure(deps, enrollment, errorMessage(err), summary);
      } catch {
        // Até a escrita de falha falhou (DB fora do ar no meio do tick) — o
        // enrollment fica com o claim até o lease expirar e um tick futuro
        // tenta de novo; nunca deixa isso derrubar os OUTROS enrollments do lote.
      }
    }
  }

  return summary;
}

/** Production adapter: `AdminClient` backed by the real Supabase service-role client. */
export function createSupabaseAdminClient(admin: SupabaseClient): AdminClient {
  return {
    async claimDueEnrollments(limit, leaseSeconds) {
      const { data, error } = await admin.rpc("fn_claim_due_followup_enrollments", {
        p_limit: limit,
        p_lease_seconds: leaseSeconds,
      });
      if (error) throw new Error(error.message);
      return (data ?? []) as EnrollmentRow[];
    },
    async loadFlowGraph(orgId, versionId) {
      const { data, error } = await admin
        .from("followup_flow_versions")
        .select("graph")
        .eq("organization_id", orgId)
        .eq("id", versionId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return null;
      return flowGraphSchema.parse(data.graph);
    },
    async loadLeadFacts(orgId, contactId) {
      const { data, error } = await admin
        .from("crm_leads")
        .select("stage_id, tags")
        .eq("organization_id", orgId)
        .eq("contact_id", contactId)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return { lead_stage: data?.stage_id ?? null, tags: data?.tags ?? [] };
    },
    async loadEnrollmentEvents(enrollmentId) {
      const { data, error } = await admin
        .from("followup_enrollment_events")
        .select("node_id, idempotency_key")
        .eq("enrollment_id", enrollmentId);
      if (error) throw new Error(error.message);
      return data ?? [];
    },
    async insertEnrollmentEvent(event) {
      const { error } = await admin.from("followup_enrollment_events").insert(event);
      if (error) {
        if (error.code === "23505") return { inserted: false };
        throw new Error(error.message);
      }
      return { inserted: true };
    },
    async updateEnrollment(id, orgId, patch) {
      const { error } = await admin.from("followup_enrollments").update(patch).eq("id", id).eq("organization_id", orgId);
      if (error) throw new Error(error.message);
    },
    async loadFlowPointerName(orgId, pointerId) {
      const { data, error } = await admin
        .from("followup_flow_pointers")
        .select("name")
        .eq("organization_id", orgId)
        .eq("id", pointerId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data?.name ?? null;
    },
    async insertDeadInboxItem(item) {
      const { error } = await admin.from("agent_inbox_items").insert({
        organization_id: item.organization_id,
        kind: "followup_dead",
        severity: "warn",
        title: item.title,
        body: item.body,
        ref_kind: "followup_enrollment",
        ref_id: item.ref_id,
      });
      if (error) throw new Error(error.message);
    },
  };
}
