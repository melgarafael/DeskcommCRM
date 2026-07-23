/**
 * Node handlers for the follow-up flow engine (Task 4.1) — PURE, no DB access.
 * `engine.ts` owns the tick/DB orchestration; this file only decides "given
 * this node + these facts, what happens next" so it's testable without Postgres.
 */
import type { FlowEdge, FlowNode } from "./graph-schema";

export type EnrollmentStatus =
  | "active"
  | "waiting_reply"
  | "paused_handoff"
  | "completed"
  | "cancelled"
  | "dead";

export type EnrollmentOutcome = "converted" | "replied" | "exhausted" | "opted_out" | "handoff";

/**
 * Snapshot of a `followup_enrollments` row — plain data (not tied to any DB
 * client) so both the pg-backed test adapter and a future supabase-js adapter
 * can produce it. Field names mirror the table (migration 0054) 1:1.
 */
export interface EnrollmentRow {
  id: string;
  organization_id: string;
  pointer_id: string;
  version_id: string;
  contact_id: string;
  conversation_id: string | null;
  current_node_id: string;
  status: EnrollmentStatus;
  next_eval_at: string | null;
  claimed_until: string | null;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  steps_taken: number;
  outcome: EnrollmentOutcome | null;
  cancel_reason: string | null;
  started_at: string;
  completed_at: string | null;
  updated_at: string;
}

/** Minimal typed facts a `condition` node can check — loaded by the engine, never guessed. */
export interface LeadFacts {
  lead_stage: string | null;
  tags: string[];
  steps_taken: number;
  last_outcome: string | null;
}

/** Reference to a `followup_enrollment_events` row — only what `resolveWaitPhase` needs. */
export interface EnrollmentEventRef {
  node_id: string | null;
  idempotency_key: string | null;
}

export type NodeResult =
  | { kind: "advance"; next_node_id: string; next_eval_at: Date }
  | { kind: "wait"; next_eval_at: Date } // stays on the node
  | {
      kind: "enqueue_turn";
      purpose: "send_message" | "classify" | "decide_timing";
      wake_status: "active" | "waiting_reply";
    }
  // action recheck: the send turn is already in flight; stay put WITHOUT re-enqueuing (anti-dup-send).
  | { kind: "recheck"; next_eval_at: Date }
  // action dead-man: the turn never completed after MAX_ACTION_RECHECKS — give up (engine routes to markDead).
  | { kind: "dead"; reason: string }
  // outcome is nullable for the 'custom' end-node case (cancel_reason carries the note instead).
  | { kind: "complete"; outcome: EnrollmentOutcome | null; cancel_reason?: string }
  | { kind: "fail"; error: string };

/** Backoff ladder indexed by `attempts - 1` (clamped to the last slot) — 30s..1h. */
export const BACKOFF_MS = [30_000, 60_000, 300_000, 900_000, 3_600_000] as const;

/** Recheck cadence while an action's send turn is in flight — how long the engine waits before
 *  looking again to see if the turn landed. Imported by engine.ts for the enqueue next_eval_at too. */
export const ACTION_RECHECK_MS = 5 * 60_000;

/** Dead-man bound: idle rechecks tolerated on an action node before a turn that never completes
 *  (worker down / permanently failing) is markDead — never re-enqueues, never waits forever. */
export const MAX_ACTION_RECHECKS = 5;

export type EdgeMatch =
  | { type: "always" }
  | { type: "class_match"; value: string }
  | { type: "cond_result"; value: boolean };

/**
 * Picks the outbound edge from `from`: highest `priority` first, exact
 * condition match tried first, `always` as fallback. `null` if nothing fits.
 */
export function selectEdge(edges: FlowEdge[], from: string, match: EdgeMatch): FlowEdge | null {
  const candidates = edges.filter((e) => e.source === from).slice().sort((a, b) => b.priority - a.priority);

  const exact = candidates.find((e) => {
    if (match.type === "always") return e.condition.type === "always";
    if (match.type === "class_match") return e.condition.type === "class_match" && e.condition.value === match.value;
    return e.condition.type === "cond_result" && e.condition.value === match.value;
  });
  if (exact) return exact;

  if (match.type !== "always") {
    const fallback = candidates.find((e) => e.condition.type === "always");
    if (fallback) return fallback;
  }
  return null;
}

/**
 * A `wait` node is entered twice: once to start the timer (writes the
 * generic step event), once after `next_eval_at` elapses to advance. Both
 * ticks see the SAME node (current_node_id unchanged) with `steps_taken`
 * incrementing by exactly 1 on every applied step (engine.ts) — so "did we
 * already start this wait" is exactly "does the event for the PRIOR step on
 * this node exist".
 */
export function resolveWaitPhase(events: EnrollmentEventRef[], nodeId: string, stepsTaken: number): boolean {
  const priorKey = `${nodeId}:${stepsTaken - 1}`;
  return events.some((e) => e.node_id === nodeId && e.idempotency_key === priorKey);
}

function evaluateCheck(
  check: { field: "lead_stage" | "tag" | "steps_taken" | "last_outcome"; op: "eq" | "neq" | "gte" | "lte" | "contains"; value: string | number },
  lead: LeadFacts,
): boolean {
  const actual: string | number | null | string[] =
    check.field === "lead_stage" ? lead.lead_stage
    : check.field === "tag" ? lead.tags
    : check.field === "steps_taken" ? lead.steps_taken
    : lead.last_outcome;

  if (Array.isArray(actual)) {
    // 'tag' é multi-valorado: eq/contains viram "está entre as tags"; gte/lte não fazem sentido.
    const included = actual.includes(String(check.value));
    if (check.op === "eq" || check.op === "contains") return included;
    if (check.op === "neq") return !included;
    return false;
  }

  switch (check.op) {
    case "eq":
      return actual === check.value;
    case "neq":
      return actual !== check.value;
    case "gte":
      return typeof actual === "number" && typeof check.value === "number" && actual >= check.value;
    case "lte":
      return typeof actual === "number" && typeof check.value === "number" && actual <= check.value;
    case "contains":
      return typeof actual === "string" && typeof check.value === "string" && actual.includes(check.value);
  }
}

function evaluateCondition(
  config: Extract<FlowNode, { type: "condition" }>["config"],
  lead: LeadFacts,
): boolean {
  const results = config.checks.map((check) => evaluateCheck(check, lead));
  return config.combinator === "and" ? results.every(Boolean) : results.some(Boolean);
}

/**
 * Pure per-node decision. `waitElapsed` is resolved by the engine (via
 * `resolveWaitPhase` against real events) BEFORE calling this — optional so
 * non-`wait`/`ai_classify` calls don't need to pass it. For `ai_classify` it
 * means "a classify turn was already enqueued for this occupancy of the node"
 * (same prior-step-event check as `wait`) — re-entering with it `true` means
 * EITHER `grace_timeout_ms` elapsed without a completed classification OR
 * reactivity (Task 5.2, `lib/followup/reactivity.ts`) woke the node early
 * because an inbound reply arrived. `wokeEarly` is the signal that
 * disambiguates the two (own marker event, distinct from the
 * `classify_enqueued` event `waitElapsed` checks): `true` re-enqueues a fresh
 * classify turn with the real reply instead of auto-advancing via `no_reply`.
 */
export function processNode(input: {
  node: FlowNode;
  edges: FlowEdge[];
  enrollment: EnrollmentRow;
  lead: LeadFacts;
  clock: () => Date;
  waitElapsed?: boolean;
  wokeEarly?: boolean;
  /** action occupancy guard: a `turn_enqueued` event for THIS stay on the action node already
   *  exists (an entry/recheck happened before). Resolved by the engine via `resolveWaitPhase`
   *  — same prior-step-event check as `wait`. When true, the send turn is in flight: DON'T
   *  re-enqueue (a second job_id would bypass the send sink's (job_id,seq) dedup → dup message). */
  actionEnqueued?: boolean;
  /** action dead-man counter: number of events already accumulated on this action node — used to
   *  bound rechecks so a turn that never completes routes to `dead` instead of looping forever. */
  actionRecheckCount?: number;
}): NodeResult {
  const { node, edges, clock, lead, waitElapsed, wokeEarly, actionEnqueued, actionRecheckCount } = input;

  switch (node.type) {
    case "trigger": {
      const edge = selectEdge(edges, node.id, { type: "always" });
      if (!edge) return { kind: "fail", error: `trigger node "${node.id}" has no outbound edge` };
      return { kind: "advance", next_node_id: edge.target, next_eval_at: clock() };
    }

    case "wait": {
      if (!waitElapsed) {
        const durationMs = node.config.mode === "fixed" ? node.config.duration_ms : node.config.max_ms; // onda 5: smart usa max_ms até a IA propor o instante (clampado)
        return { kind: "wait", next_eval_at: new Date(clock().getTime() + durationMs) };
      }
      const edge = selectEdge(edges, node.id, { type: "always" });
      if (!edge) return { kind: "fail", error: `wait node "${node.id}" has no outbound edge after elapsing` };
      return { kind: "advance", next_node_id: edge.target, next_eval_at: clock() };
    }

    case "condition": {
      const result = evaluateCondition(node.config, lead);
      const edge = selectEdge(edges, node.id, { type: "cond_result", value: result });
      if (!edge) return { kind: "fail", error: `condition node "${node.id}" has no matching edge for result ${result}` };
      return { kind: "advance", next_node_id: edge.target, next_eval_at: clock() };
    }

    case "ai_classify": {
      if (!waitElapsed || wokeEarly) {
        // 1ª entrada (waitElapsed=false) OU reactivity acordou cedo com uma
        // resposta real (wokeEarly=true, mesmo com waitElapsed=true — o marker
        // de reactivity é o desempate): reenfileira classify. Nunca conta como
        // 'no_reply' quando existe reply de verdade em voo.
        return { kind: "enqueue_turn", purpose: "classify", wake_status: "waiting_reply" };
      }
      // grace_timeout_ms venceu sem turno de classificação concluído — classifica
      // como 'no_reply' SEM chamar o LLM (onda 5, critério 2); selectEdge já cai
      // no fallback 'always' se não houver aresta 'no_reply' explícita.
      const edge = selectEdge(edges, node.id, { type: "class_match", value: "no_reply" });
      if (!edge) return { kind: "fail", error: `ai_classify node "${node.id}" has no edge for class "no_reply" (fallback also missing)` };
      return { kind: "advance", next_node_id: edge.target, next_eval_at: clock() };
    }

    case "action": {
      // At-most-once send: enqueue the turn EXACTLY ONCE per occupancy. First entry
      // (no prior occupancy event) enqueues; a recheck fired while the turn is still in
      // flight — completeTurnForEnrollment (turn-bridge) hasn't advanced the enrollment
      // yet — must NOT re-enqueue. Mirrors the wait/ai_classify guard (resolveWaitPhase),
      // which the action node lacked (steps_taken increments every recheck, so the
      // `${node}:${steps}` idempotency_key was a FRESH key each tick → a 2nd job → a 2nd
      // real send that the send sink's (job_id,seq) dedup can't catch).
      if (!actionEnqueued) {
        return { kind: "enqueue_turn", purpose: "send_message", wake_status: "active" };
      }
      // Dead-man: the turn never completed (worker down / turn permanently failing). Never
      // re-enqueue, never wait forever — after MAX_ACTION_RECHECKS idle rechecks give up.
      // ponytail: recheck budget is counted per-node over the enrollment's lifetime, so a
      // flow that LOOPS back to the same action node shares the budget (re-sending on a
      // loop is itself an anti-ban smell). Precise per-occupancy counting would need the
      // event_type, which EnrollmentEventRef doesn't carry — upgrade there if loops appear.
      if ((actionRecheckCount ?? 0) >= MAX_ACTION_RECHECKS) {
        return { kind: "dead", reason: "action_turn_never_completed" };
      }
      return { kind: "recheck", next_eval_at: new Date(clock().getTime() + ACTION_RECHECK_MS) };
    }

    case "end": {
      if (node.config.outcome === "custom") {
        return { kind: "complete", outcome: null, cancel_reason: node.config.note };
      }
      return { kind: "complete", outcome: node.config.outcome };
    }
  }
}
