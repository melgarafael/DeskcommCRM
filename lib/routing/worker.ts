/**
 * Worker de roteamento de conversas (G5-02 — AT-03, spec 13 §5).
 *
 * Doutrina: trigger NUNCA faz HTTP. A entrada da conversa na fila emite
 * `conversation.routing_requested` em `event_log` (trigger AFTER INSERT em
 * conversations, migration 0040); ESTE worker (cron TS) drena o evento, resolve
 * o modo da org e atribui — como service_role (admin client bypassa RLS, então
 * TODA query filtra organization_id vindo do payload confiável do evento).
 *
 * Mecânica de claim = mesma do agent-dispatcher: CAS status pending→processing,
 * `consumed_by` marca o consumidor, `next_attempt_at`/`attempts` reenfileiram.
 * A lógica de decisão (manual/round_robin/no-eligible/replay) é pura em
 * lib/routing/decide.ts; aqui só há I/O.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";
import { isAttendantEligible, OPEN_LOAD_STATUSES } from "@/lib/routing/eligibility";
import { decideRouting, type RoutingCandidate } from "@/lib/routing/decide";
import { routingConfigSchema, availabilityScheduleSchema } from "@/lib/schemas/routing";

export const ROUTING_WORKER_KEY = "worker.routing.v1";
export const ROUTING_EVENT_TYPE = "conversation.routing_requested";

const DEFAULT_BATCH_SIZE = 100;

export type RoutingOutcome =
  | "assigned"
  | "skipped_manual"
  | "skipped_already_assigned"
  | "skipped_unsupported_mode"
  | "requeued_no_eligible"
  | "dead_no_eligible"
  | "skipped_conv_missing"
  | "skipped_invalid_payload"
  | "assign_lost_race"
  | "error";

export interface RoutingSummary {
  batch_size: number;
  outcomes: Record<RoutingOutcome, number>;
  errors: string[];
}

interface EventRow {
  id: string;
  organization_id: string;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown> | null;
  consumed_by: string[];
  attempts: number;
}

const EMPTY_OUTCOMES = (): Record<RoutingOutcome, number> => ({
  assigned: 0,
  skipped_manual: 0,
  skipped_already_assigned: 0,
  skipped_unsupported_mode: 0,
  requeued_no_eligible: 0,
  dead_no_eligible: 0,
  skipped_conv_missing: 0,
  skipped_invalid_payload: 0,
  assign_lost_race: 0,
  error: 0,
});

export interface RoutingWorkerOptions {
  batchSize?: number;
  /** Relógio injetável (testes) — usado na elegibilidade (horário) e no backoff. */
  now?: Date;
}

export async function runRoutingWorker(opts: RoutingWorkerOptions = {}): Promise<RoutingSummary> {
  const admin = createAdminClient();
  const now = opts.now ?? new Date();
  const batchSize = Math.min(Math.max(opts.batchSize ?? DEFAULT_BATCH_SIZE, 1), 500);
  const summary: RoutingSummary = { batch_size: 0, outcomes: EMPTY_OUTCOMES(), errors: [] };

  const { data: rawEvents, error: pullErr } = await admin
    .from("event_log")
    .select("id, organization_id, payload, metadata, consumed_by, attempts, next_attempt_at, status")
    .eq("event_type", ROUTING_EVENT_TYPE)
    .eq("status", "pending")
    .or(`next_attempt_at.is.null,next_attempt_at.lte.${now.toISOString()}`)
    .order("created_at", { ascending: true })
    .limit(batchSize);

  if (pullErr) {
    summary.errors.push(`event_log_pull_failed: ${pullErr.message}`);
    return summary;
  }

  const events = (rawEvents ?? []).filter(
    (e) => !(Array.isArray(e.consumed_by) && e.consumed_by.includes(ROUTING_WORKER_KEY)),
  ) as EventRow[];

  for (const event of events) {
    const claimed = await claimEvent(event.id);
    if (!claimed) continue;
    summary.batch_size += 1;
    try {
      const outcome = await processEvent(event, now);
      summary.outcomes[outcome] += 1;
    } catch (err) {
      summary.outcomes.error += 1;
      const detail = err instanceof Error ? err.message : String(err);
      summary.errors.push(`${event.id}:${detail}`);
      logger.error("[routing-worker] processEvent threw", {
        event_id: event.id,
        organization_id: event.organization_id,
        error: detail,
      });
      await requeueEvent(event, now, event.attempts + 1, { error: detail.slice(0, 200) });
    }
  }

  return summary;
}

async function processEvent(event: EventRow, now: Date): Promise<RoutingOutcome> {
  const admin = createAdminClient();
  const payload = event.payload ?? {};
  const orgId = strOrNull(payload.organization_id) ?? event.organization_id;
  const conversationId = strOrNull(payload.conversation_id);

  if (!conversationId || orgId !== event.organization_id) {
    await markDone(event, "skipped_invalid_payload");
    return "skipped_invalid_payload";
  }

  const { data: conv } = await admin
    .from("conversations")
    .select("id, organization_id, assigned_to_user_id, status")
    .eq("id", conversationId)
    .eq("organization_id", orgId)
    .maybeSingle();

  if (!conv) {
    await markDone(event, "skipped_conv_missing");
    return "skipped_conv_missing";
  }

  // organizations.settings.routing → Zod (default manual; knobs = config, não hardcode).
  const { data: org } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", orgId)
    .maybeSingle();
  const settings = (org?.settings ?? {}) as { routing?: unknown };
  const config = routingConfigSchema.parse(settings.routing ?? {});

  const alreadyAssigned = Boolean(conv.assigned_to_user_id);
  const eligibles =
    !alreadyAssigned && config.mode === "round_robin"
      ? await loadEligibles(orgId, now)
      : [];

  const action = decideRouting({
    mode: config.mode,
    alreadyAssigned,
    eligibles,
    config,
    attempts: event.attempts,
    now,
  });

  switch (action.kind) {
    case "assign": {
      // Optimistic lock: expected=null ⇒ só atribui se AINDA sem dono. Grava
      // conversation_assignment_events(reason='routing') na MESMA transação (fn).
      const { data: rows, error } = await admin.rpc("fn_conversation_assign", {
        p_organization_id: orgId,
        p_conversation_id: conversationId,
        p_to_user_id: action.userId,
        p_reason: "routing",
        p_expected_assignee: null,
        p_enforce_expected: true,
      });
      if (error) throw new Error(`fn_conversation_assign: ${error.message}`);
      if (!Array.isArray(rows) || rows.length === 0) {
        // 0 rows = ganhou dono entre o load e o assign (replay/corrida): não reatribui.
        await markDone(event, "assign_lost_race");
        return "assign_lost_race";
      }
      await markDone(event, "assigned", { assigned_to_user_id: action.userId });
      return "assigned";
    }
    case "skip": {
      const outcome: RoutingOutcome =
        action.reason === "manual_mode"
          ? "skipped_manual"
          : action.reason === "already_assigned"
            ? "skipped_already_assigned"
            : "skipped_unsupported_mode";
      if (action.reason.startsWith("unsupported_mode")) {
        logger.warn("[routing-worker] modo não suportado (post-MVP) — no-op", {
          organization_id: orgId,
          mode: config.mode,
        });
      }
      await markDone(event, outcome);
      return outcome;
    }
    case "requeue": {
      await requeueEvent(event, now, action.attempts, { reason: "no_eligible" }, action.nextAttemptAt);
      return "requeued_no_eligible";
    }
    case "dead": {
      await markDead(event, action.reason);
      return "dead_no_eligible";
    }
  }
}

/** Elegíveis = disponíveis ∧ dentro do horário ∧ com folga (carga < capacidade). */
async function loadEligibles(orgId: string, now: Date): Promise<RoutingCandidate[]> {
  const admin = createAdminClient();

  const { data: avail } = await admin
    .from("attendant_availability")
    .select("user_id, capacity, schedule")
    .eq("organization_id", orgId)
    .eq("is_available", true);

  const rows = (avail ?? []) as Array<{ user_id: string; capacity: number; schedule: unknown }>;
  if (rows.length === 0) return [];

  const userIds = rows.map((r) => r.user_id);

  // Carga atual: conversas abertas atribuídas, contadas por dono (1 query).
  const { data: openConvs } = await admin
    .from("conversations")
    .select("assigned_to_user_id")
    .eq("organization_id", orgId)
    .in("assigned_to_user_id", userIds)
    .in("status", OPEN_LOAD_STATUSES as unknown as string[]);
  const loadByUser = new Map<string, number>();
  for (const c of (openConvs ?? []) as Array<{ assigned_to_user_id: string | null }>) {
    if (c.assigned_to_user_id) {
      loadByUser.set(c.assigned_to_user_id, (loadByUser.get(c.assigned_to_user_id) ?? 0) + 1);
    }
  }

  // Última atribuição recebida (rodízio real, sem coluna de estado).
  const { data: assignEvents } = await admin
    .from("conversation_assignment_events")
    .select("to_user_id, created_at")
    .eq("organization_id", orgId)
    .in("to_user_id", userIds)
    .order("created_at", { ascending: false });
  const lastAssignedByUser = new Map<string, number>();
  for (const e of (assignEvents ?? []) as Array<{ to_user_id: string | null; created_at: string }>) {
    if (e.to_user_id && !lastAssignedByUser.has(e.to_user_id)) {
      lastAssignedByUser.set(e.to_user_id, new Date(e.created_at).getTime());
    }
  }

  const candidates: RoutingCandidate[] = [];
  for (const r of rows) {
    const currentLoad = loadByUser.get(r.user_id) ?? 0;
    const schedule = availabilityScheduleSchema.parse(r.schedule ?? {});
    const eligible = isAttendantEligible(
      { isAvailable: true, capacity: r.capacity, currentLoad, schedule },
      now,
    );
    if (eligible) {
      candidates.push({
        userId: r.user_id,
        currentLoad,
        lastAssignedAt: lastAssignedByUser.get(r.user_id) ?? null,
      });
    }
  }
  return candidates;
}

// --- event lifecycle (mesma mecânica do agent-dispatcher; status ∈ pending|processing|done|dead) ---

async function claimEvent(eventId: string): Promise<boolean> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("event_log")
    .update({ status: "processing", updated_at: new Date().toISOString() })
    .eq("id", eventId)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();
  if (error) {
    logger.warn("[routing-worker] claim failed", { event_id: eventId, error: error.message });
    return false;
  }
  return Boolean(data);
}

async function markDone(
  event: EventRow,
  outcome: RoutingOutcome,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const admin = createAdminClient();
  const consumed = Array.isArray(event.consumed_by) ? event.consumed_by.slice() : [];
  if (!consumed.includes(ROUTING_WORKER_KEY)) consumed.push(ROUTING_WORKER_KEY);
  const { error } = await admin
    .from("event_log")
    .update({
      status: "done",
      consumed_by: consumed,
      metadata: { ...(event.metadata ?? {}), outcome, handled_by: ROUTING_WORKER_KEY, ...extra },
      updated_at: new Date().toISOString(),
    })
    .eq("id", event.id);
  if (error) logger.warn("[routing-worker] markDone failed", { event_id: event.id, error: error.message });
}

async function requeueEvent(
  event: EventRow,
  now: Date,
  attempts: number,
  extra: Record<string, unknown>,
  nextAttemptAt?: string,
): Promise<void> {
  const admin = createAdminClient();
  const next = nextAttemptAt ?? new Date(now.getTime() + 60_000).toISOString();
  const { error } = await admin
    .from("event_log")
    .update({
      status: "pending",
      attempts,
      next_attempt_at: next,
      metadata: { ...(event.metadata ?? {}), last_requeue: { ...extra, at: now.toISOString() } },
      updated_at: new Date().toISOString(),
    })
    .eq("id", event.id);
  if (error) logger.warn("[routing-worker] requeue failed", { event_id: event.id, error: error.message });
}

async function markDead(event: EventRow, reason: string): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("event_log")
    .update({
      status: "dead",
      attempts: event.attempts + 1,
      last_error: reason.slice(0, 500),
      metadata: { ...(event.metadata ?? {}), outcome: "dead", reason },
      updated_at: new Date().toISOString(),
    })
    .eq("id", event.id);
  if (error) logger.warn("[routing-worker] markDead failed", { event_id: event.id, error: error.message });
}

function strOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}
