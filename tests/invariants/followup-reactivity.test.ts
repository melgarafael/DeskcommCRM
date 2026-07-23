import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { runFollowupTick, type FollowupJobRequest, type TickDeps, type AdminClient } from "@/lib/followup/engine";
import { completeTurnForEnrollment, createPgAdminClient } from "@/lib/followup/turn-bridge";
import {
  applyReactivityEvent,
  RESUME_GRACE_MS,
  type LiveEnrollmentRef,
  type ReactivityAdminClient,
} from "@/lib/followup/reactivity";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { flowGraphSchema, type FlowGraph } from "@/lib/followup/graph-schema";
import type { EnrollmentEventRef, EnrollmentRow } from "@/lib/followup/node-handlers";

/**
 * Task 5.2 — reatividade (inbound acorda classify, STOP cancela tudo, handoff
 * pausa/retoma) contra Postgres real (baseline aplicado, inclui os apêndices
 * até 0057). DESVIO DELIBERADO do esboço do brief: em vez de um cursor próprio
 * em `watchdog_cursors`, reactivity pluga no dispatcher genérico de event_log
 * já existente (`lib/event-log/dispatcher.ts` — idempotência via
 * `consumed_by[]`, já em produção via `event-log-drain` a cada minuto). Este
 * arquivo prova `applyReactivityEvent` diretamente (mesmo padrão de
 * `completeTurnForEnrollment` em followup-turn-bridge.test.ts) — o handler.ts
 * fino que pluga no dispatcher não tem lógica própria pra testar.
 *
 * Congela: (1) STOP cancela TUDO que está vivo (opted_out), idempotente sob
 * re-drain; (2) inbound em waiting_reply sem cancel_on_reply acorda (marker +
 * next_eval_at=now) e o PRÓPRIO tick do engine classifica em vez de rotear
 * no_reply (a corrida classify-lento documentada no HANDOFF); (3) inbound com
 * cancel_on_reply=true cancela (replied); (4) handoff aberto aplica a política
 * do pointer (pause/cancel/allow); (5) O CENTERPIECE anti-Tomik: pausa por
 * handoff → fecha → retoma pra active com next_eval_at setado, nunca preso.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:invariants` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 4,
});

afterAll(async () => {
  await pool.end();
});

// ---- pg-backed ReactivityAdminClient (test-only; prod usa createSupabaseReactivityClient) ----

const LIVE_STATUSES = ["active", "waiting_reply", "paused_handoff"];

function reactivityDb(): ReactivityAdminClient {
  return {
    async loadConversationContactId(orgId, conversationId) {
      const { rows } = await pool.query<{ contact_id: string }>(
        `select contact_id from conversations where id = $1 and organization_id = $2`,
        [conversationId, orgId],
      );
      return rows[0]?.contact_id ?? null;
    },
    async loadContactBlocked(orgId, contactId) {
      const { rows } = await pool.query<{ is_blocked: boolean }>(
        `select is_blocked from contacts where id = $1 and organization_id = $2`,
        [contactId, orgId],
      );
      return rows[0]?.is_blocked ?? false;
    },
    async loadLiveEnrollmentsForContact(orgId, contactId): Promise<LiveEnrollmentRef[]> {
      const { rows } = await pool.query(
        `select e.id, e.status, e.current_node_id, e.steps_taken, e.pointer_id,
                p.handoff_policy, p.trigger_config
         from followup_enrollments e
         join followup_flow_pointers p on p.id = e.pointer_id
         where e.organization_id = $1 and e.contact_id = $2 and e.status = any($3)`,
        [orgId, contactId, LIVE_STATUSES],
      );
      return rows;
    },
    async insertEnrollmentEvent(event) {
      try {
        await pool.query(
          `insert into followup_enrollment_events (organization_id, enrollment_id, node_id, event_type, payload, idempotency_key)
           values ($1, $2, $3, $4, $5, $6)`,
          [event.organization_id, event.enrollment_id, event.node_id, event.event_type, event.payload, event.idempotency_key],
        );
        return { inserted: true };
      } catch (err) {
        if ((err as { code?: string }).code === "23505") return { inserted: false };
        throw err;
      }
    },
    async updateEnrollment(id, orgId, patch) {
      const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
      if (entries.length === 0) return;
      const setSql = entries.map(([k], i) => `${k} = $${i + 3}`).join(", ");
      const values = entries.map(([, v]) => v);
      await pool.query(`update followup_enrollments set ${setSql} where id = $1 and organization_id = $2`, [
        id,
        orgId,
        ...values,
      ]);
    },
  };
}

// ---- pg-backed AdminClient (engine) — mesmo adapter usado em followup-engine.test.ts ----

function toIso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

function mapEnrollmentRow(row: Record<string, unknown>): EnrollmentRow {
  return {
    id: row.id as string,
    organization_id: row.organization_id as string,
    pointer_id: row.pointer_id as string,
    version_id: row.version_id as string,
    contact_id: row.contact_id as string,
    conversation_id: (row.conversation_id as string | null) ?? null,
    current_node_id: row.current_node_id as string,
    status: row.status as EnrollmentRow["status"],
    next_eval_at: toIso(row.next_eval_at),
    claimed_until: toIso(row.claimed_until),
    attempts: Number(row.attempts),
    max_attempts: Number(row.max_attempts),
    last_error: (row.last_error as string | null) ?? null,
    steps_taken: Number(row.steps_taken),
    outcome: (row.outcome as EnrollmentRow["outcome"]) ?? null,
    cancel_reason: (row.cancel_reason as string | null) ?? null,
    started_at: toIso(row.started_at)!,
    completed_at: toIso(row.completed_at),
    updated_at: toIso(row.updated_at)!,
  };
}

function engineDb(): AdminClient {
  return {
    async claimDueEnrollments(limit, leaseSeconds) {
      const { rows } = await pool.query(`select * from fn_claim_due_followup_enrollments($1, $2)`, [limit, leaseSeconds]);
      return rows.map(mapEnrollmentRow);
    },
    async loadFlowGraph(orgId, versionId) {
      const { rows } = await pool.query<{ graph: unknown }>(
        `select graph from followup_flow_versions where organization_id = $1 and id = $2`,
        [orgId, versionId],
      );
      if (rows.length === 0) return null;
      return flowGraphSchema.parse(rows[0]!.graph);
    },
    async loadLeadFacts() {
      return { lead_stage: null, tags: [] };
    },
    async loadEnrollmentEvents(enrollmentId): Promise<EnrollmentEventRef[]> {
      const { rows } = await pool.query<EnrollmentEventRef>(
        `select node_id, idempotency_key from followup_enrollment_events where enrollment_id = $1`,
        [enrollmentId],
      );
      return rows;
    },
    async insertEnrollmentEvent(event) {
      try {
        await pool.query(
          `insert into followup_enrollment_events (organization_id, enrollment_id, node_id, event_type, payload, idempotency_key)
           values ($1, $2, $3, $4, $5, $6)`,
          [event.organization_id, event.enrollment_id, event.node_id, event.event_type, event.payload, event.idempotency_key],
        );
        return { inserted: true };
      } catch (err) {
        if ((err as { code?: string }).code === "23505") return { inserted: false };
        throw err;
      }
    },
    async updateEnrollment(id, orgId, patch) {
      const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
      if (entries.length === 0) return;
      const setSql = entries.map(([k], i) => `${k} = $${i + 3}`).join(", ");
      const values = entries.map(([, v]) => v);
      await pool.query(`update followup_enrollments set ${setSql} where id = $1 and organization_id = $2`, [
        id,
        orgId,
        ...values,
      ]);
    },
    async loadFlowPointerName(orgId, pointerId) {
      const { rows } = await pool.query<{ name: string }>(
        `select name from followup_flow_pointers where organization_id = $1 and id = $2`,
        [orgId, pointerId],
      );
      return rows[0]?.name ?? null;
    },
    async insertDeadInboxItem(item) {
      await pool.query(
        `insert into agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
         values ($1, 'followup_dead', 'warn', $2, $3, 'followup_enrollment', $4)`,
        [item.organization_id, item.title, item.body, item.ref_id],
      );
    },
  };
}

// ---- seed helpers ----

let orgSeq = 0;
function nextOrgId(): string {
  orgSeq += 1;
  return `cccccc${String(orgSeq).padStart(2, "0")}-0000-4000-8000-000000000001`;
}

async function seedOrg(org: string): Promise<void> {
  const name = `followup-reactivity-${org.slice(0, 8)}`;
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1, $2, $3, $4) on conflict (id) do nothing`,
    [org, name, name, name],
  );
}

async function seedContact(org: string, opts?: { isBlocked?: boolean }): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, display_name, is_blocked) values ($1, 'Reactivity Contact', $2) returning id`,
    [org, opts?.isBlocked ?? false],
  );
  return rows[0]!.id;
}

async function seedConversation(org: string, contactId: string): Promise<string> {
  const { rows: sessRows } = await pool.query<{ id: string }>(
    `insert into channel_sessions (organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1, $2, 'WORKING', '\\x00'::bytea) returning id`,
    [org, `reactivity-session-${Date.now()}-${Math.random()}`],
  );
  const sessionId = sessRows[0]!.id;
  const { rows: convRows } = await pool.query<{ id: string }>(
    `insert into conversations (organization_id, contact_id, channel_session_id, status, is_group)
     values ($1, $2, $3, 'open', false) returning id`,
    [org, contactId, sessionId],
  );
  return convRows[0]!.id;
}

async function seedFlow(
  org: string,
  graph: FlowGraph,
  opts?: { handoffPolicy?: "pause" | "cancel" | "allow"; triggerConfig?: unknown },
): Promise<{ pointerId: string; versionId: string }> {
  const { rows: versionRows } = await pool.query<{ id: string }>(
    `insert into followup_flow_versions (organization_id, graph) values ($1, $2) returning id`,
    [org, JSON.stringify(graph)],
  );
  const versionId = versionRows[0]!.id;
  const { rows: pointerRows } = await pool.query<{ id: string }>(
    `insert into followup_flow_pointers (organization_id, name, status, active_version_id, handoff_policy, trigger_config)
     values ($1, $2, 'active', $3, $4, $5) returning id`,
    [
      org,
      `Reactivity Flow ${Date.now()}-${Math.random()}`,
      versionId,
      opts?.handoffPolicy ?? "pause",
      JSON.stringify(opts?.triggerConfig ?? { kind: "manual" }),
    ],
  );
  return { pointerId: pointerRows[0]!.id, versionId };
}

async function seedEnrollment(params: {
  org: string;
  pointerId: string;
  versionId: string;
  contactId: string;
  currentNodeId: string;
  status?: string;
  stepsTaken?: number;
  /** ISO timestamp, or omit for "due 1h from now" (default), or pass null explicitly (paused_handoff). */
  nextEvalAt?: string | null;
}): Promise<string> {
  const status = params.status ?? "active";
  const nextEvalAt =
    params.nextEvalAt !== undefined
      ? params.nextEvalAt
      : status === "paused_handoff"
        ? null
        : new Date(Date.now() + 3_600_000).toISOString();
  const { rows } = await pool.query<{ id: string }>(
    `insert into followup_enrollments
       (organization_id, pointer_id, version_id, contact_id, current_node_id, status, next_eval_at, steps_taken)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning id`,
    [params.org, params.pointerId, params.versionId, params.contactId, params.currentNodeId, status, nextEvalAt, params.stepsTaken ?? 0],
  );
  return rows[0]!.id;
}

async function getEnrollment(id: string): Promise<Record<string, unknown>> {
  const { rows } = await pool.query(`select * from followup_enrollments where id = $1`, [id]);
  return rows[0]!;
}

async function getEvents(enrollmentId: string): Promise<{ event_type: string; idempotency_key: string | null }[]> {
  const { rows } = await pool.query(
    `select event_type, idempotency_key from followup_enrollment_events where enrollment_id = $1 order by created_at`,
    [enrollmentId],
  );
  return rows;
}

function eventRow(overrides: Partial<EventRow> & Pick<EventRow, "event_type" | "organization_id" | "payload">): EventRow {
  return {
    id: overrides.id ?? `${Date.now()}-${Math.random()}`,
    entity_kind: "message",
    entity_id: null,
    metadata: {},
    consumed_by: [],
    attempts: 0,
    ...overrides,
  };
}

// ---- graphs ----

const CLASSIFY_GRAPH: FlowGraph = {
  nodes: [
    {
      id: "ac1",
      type: "ai_classify",
      label: "Classify",
      position: { x: 0, y: 0 },
      config: { classes: ["hot", "cold"], grace_timeout_ms: 900_000, target: "last_reply" },
    },
    { id: "hot-node", type: "end", label: "Hot", position: { x: 0, y: 0 }, config: { outcome: "converted" } },
    { id: "no-reply-node", type: "end", label: "NoReply", position: { x: 0, y: 0 }, config: { outcome: "exhausted" } },
  ],
  edges: [
    { id: "ac1-hot", source: "ac1", target: "hot-node", priority: 5, condition: { type: "class_match", value: "hot" } },
    { id: "ac1-noreply", source: "ac1", target: "no-reply-node", priority: 0, condition: { type: "class_match", value: "no_reply" } },
  ],
};

const SIMPLE_GRAPH: FlowGraph = {
  nodes: [
    { id: "w1", type: "wait", label: "Wait", position: { x: 0, y: 0 }, config: { mode: "fixed", duration_ms: 600_000 } },
    { id: "e1", type: "end", label: "Done", position: { x: 0, y: 0 }, config: { outcome: "converted" } },
  ],
  edges: [{ id: "w1-e1", source: "w1", target: "e1", priority: 0, condition: { type: "always" } }],
};

beforeAll(() => {
  flowGraphSchema.parse(CLASSIFY_GRAPH);
  flowGraphSchema.parse(SIMPLE_GRAPH);
});

// ---- 1. STOP cancela tudo ----

describe("applyReactivityEvent — STOP/opt-out (message.received + is_blocked)", () => {
  it("cancela o enrollment VIVO do contato (outcome='opted_out') e ignora os já terminais", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const contactId = await seedContact(org, { isBlocked: true });
    // Task 8.6: 1 follow-up vivo por lead ORG-WIDE (idx_followup_enrollments_one_live
    // virou (organization_id, contact_id) na migration 0062) — um contato tem no
    // MÁXIMO 1 enrollment vivo, não N em N fluxos. Aqui ele está num estado vivo
    // não-trivial (paused_handoff, next_eval_at já null) pra provar que o STOP o
    // cancela mesmo assim; um 2º enrollment já 'completed' (não-vivo, permitido
    // pelo índice parcial) prova que o STOP não toca terminais.
    const flow1 = await seedFlow(org, SIMPLE_GRAPH, { handoffPolicy: "pause" });
    const flow2 = await seedFlow(org, SIMPLE_GRAPH);
    const live = await seedEnrollment({ org, pointerId: flow1.pointerId, versionId: flow1.versionId, contactId, currentNodeId: "w1", status: "paused_handoff" });
    const done = await seedEnrollment({ org, pointerId: flow2.pointerId, versionId: flow2.versionId, contactId, currentNodeId: "w1", status: "completed", nextEvalAt: null });

    const row = eventRow({ organization_id: org, event_type: "message.received", payload: { contact_id: contactId } });
    const summary = await applyReactivityEvent(reactivityDb(), () => new Date(), row);
    expect(summary).toEqual({ matched: true, reacted: 1 });

    const afterLive = await getEnrollment(live);
    expect(afterLive.status).toBe("cancelled");
    expect(afterLive.outcome).toBe("opted_out");
    expect(afterLive.next_eval_at).toBeNull();

    const afterDone = await getEnrollment(done);
    expect(afterDone.status).toBe("completed"); // terminal intocado pelo STOP
  });

  it("re-drenar o MESMO event_log row é idempotente — sem efeito duplicado", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const contactId = await seedContact(org, { isBlocked: true });
    const { pointerId, versionId } = await seedFlow(org, SIMPLE_GRAPH);
    const e1 = await seedEnrollment({ org, pointerId, versionId, contactId, currentNodeId: "w1", status: "active" });

    const row = eventRow({ id: "fixed-row-1", organization_id: org, event_type: "message.received", payload: { contact_id: contactId } });
    const db = reactivityDb();
    const s1 = await applyReactivityEvent(db, () => new Date(), row);
    const s2 = await applyReactivityEvent(db, () => new Date(), row);
    expect(s1.reacted).toBe(1);
    expect(s2.reacted).toBe(0); // já cancelado — status não bate mais em LIVE_STATUSES

    const events = await getEvents(e1);
    expect(events.filter((e) => e.event_type === "reactivity_opted_out")).toHaveLength(1);
  });
});

// ---- 2. inbound acorda waiting_reply (sem cancel_on_reply) — a corrida classify-lento ----

describe("applyReactivityEvent — inbound wake (waiting_reply, sem cancel_on_reply)", () => {
  it("marca next_eval_at=now + wake marker; o TICK do engine classifica em vez de rotear no_reply", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const contactId = await seedContact(org);
    const { pointerId, versionId } = await seedFlow(org, CLASSIFY_GRAPH);

    // 1º tick: entra no ai_classify, enfileira o classify (status vira waiting_reply).
    const jobs: FollowupJobRequest[] = [];
    const eDb = engineDb();
    const tickDeps: TickDeps = { db: eDb, clock: () => new Date(), enqueueJob: async (j) => void jobs.push(j) };
    const enrollmentId = await seedEnrollment({
      org,
      pointerId,
      versionId,
      contactId,
      currentNodeId: "ac1",
      nextEvalAt: new Date(Date.now() - 1_000).toISOString(), // due agora — o 1º tick reclama
    });

    const tick1 = await runFollowupTick(tickDeps, { limit: 5 });
    expect(tick1.scheduled).toBe(1);
    expect(jobs).toHaveLength(1);
    const afterTick1 = await getEnrollment(enrollmentId);
    expect(afterTick1.status).toBe("waiting_reply");

    // Simula grace ainda NÃO vencido (next_eval_at no futuro) — a diferença
    // crucial vs a Task 5.1: o tick NÃO reclamaria isso sozinho. Reactivity
    // que empurra next_eval_at pra agora.
    await pool.query(`update followup_enrollments set next_eval_at = now() + interval '10 minutes' where id = $1`, [
      enrollmentId,
    ]);

    const row = eventRow({ organization_id: org, event_type: "message.received", payload: { contact_id: contactId } });
    const summary = await applyReactivityEvent(reactivityDb(), () => new Date(), row);
    expect(summary).toEqual({ matched: true, reacted: 1 });

    const afterWake = await getEnrollment(enrollmentId);
    expect(new Date(afterWake.next_eval_at as string).getTime()).toBeLessThanOrEqual(Date.now() + 2_000);
    expect(afterWake.status).toBe("waiting_reply"); // reactivity não muda status, só acorda

    // 2º tick: reclama por causa do next_eval_at movido. SEM o wake marker,
    // waitElapsed=true cairia em 'no_reply' (fix da Task 5.1) — descartando a
    // resposta real. COM o marker, wokeEarly=true força reenfileirar classify.
    const tick2 = await runFollowupTick(tickDeps, { limit: 5 });
    expect(tick2.scheduled).toBe(1); // reenfileirou, NÃO avançou pra no-reply-node
    expect(jobs).toHaveLength(2);

    const afterTick2 = await getEnrollment(enrollmentId);
    expect(afterTick2.current_node_id).toBe("ac1"); // continua no MESMO nó — não foi pro no-reply-node
    expect(afterTick2.status).toBe("waiting_reply");

    const events = await getEvents(enrollmentId);
    expect(events.map((e) => e.event_type)).toEqual(["classify_enqueued", "inbound_woke", "classify_enqueued"]);
  });

  it("cancel_on_reply=true no trigger_config do pointer: cancela (outcome='replied') em vez de acordar", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const contactId = await seedContact(org);
    const { pointerId, versionId } = await seedFlow(org, CLASSIFY_GRAPH, {
      triggerConfig: { kind: "manual", cancel_on_reply: true },
    });
    const enrollmentId = await seedEnrollment({ org, pointerId, versionId, contactId, currentNodeId: "ac1", status: "waiting_reply" });

    const row = eventRow({ organization_id: org, event_type: "message.received", payload: { contact_id: contactId } });
    const summary = await applyReactivityEvent(reactivityDb(), () => new Date(), row);
    expect(summary).toEqual({ matched: true, reacted: 1 });

    const after = await getEnrollment(enrollmentId);
    expect(after.status).toBe("cancelled");
    expect(after.outcome).toBe("replied");
  });

  it("cancel_on_reply ausente (schema antigo) — comportamento inalterado: acorda, não cancela", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const contactId = await seedContact(org);
    const { pointerId, versionId } = await seedFlow(org, CLASSIFY_GRAPH); // default {kind:'manual'}, sem cancel_on_reply
    const enrollmentId = await seedEnrollment({ org, pointerId, versionId, contactId, currentNodeId: "ac1", status: "waiting_reply" });

    const row = eventRow({ organization_id: org, event_type: "message.received", payload: { contact_id: contactId } });
    await applyReactivityEvent(reactivityDb(), () => new Date(), row);

    const after = await getEnrollment(enrollmentId);
    expect(after.status).toBe("waiting_reply");
    expect(after.outcome).toBeNull();
  });
});

// ---- 3. handoff aberto: pause/cancel/allow ----

describe("applyReactivityEvent — ai.handoff_triggered (aberto)", () => {
  it("handoff_policy='pause': status vira paused_handoff, next_eval_at=null", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const contactId = await seedContact(org);
    const conversationId = await seedConversation(org, contactId);
    const { pointerId, versionId } = await seedFlow(org, SIMPLE_GRAPH, { handoffPolicy: "pause" });
    const enrollmentId = await seedEnrollment({ org, pointerId, versionId, contactId, currentNodeId: "w1", status: "active" });

    const row = eventRow({
      organization_id: org,
      event_type: "ai.handoff_triggered",
      payload: { conversation_id: conversationId, reason: "low_confidence" },
    });
    const summary = await applyReactivityEvent(reactivityDb(), () => new Date(), row);
    expect(summary).toEqual({ matched: true, reacted: 1 });

    const after = await getEnrollment(enrollmentId);
    expect(after.status).toBe("paused_handoff");
    expect(after.next_eval_at).toBeNull();
    const events = await getEvents(enrollmentId);
    expect(events.map((e) => e.event_type)).toContain("handoff_paused");
  });

  it("handoff_policy='cancel': cancela (outcome='handoff')", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const contactId = await seedContact(org);
    const conversationId = await seedConversation(org, contactId);
    const { pointerId, versionId } = await seedFlow(org, SIMPLE_GRAPH, { handoffPolicy: "cancel" });
    const enrollmentId = await seedEnrollment({ org, pointerId, versionId, contactId, currentNodeId: "w1", status: "active" });

    const row = eventRow({
      organization_id: org,
      event_type: "ai.handoff_triggered",
      payload: { conversation_id: conversationId },
    });
    await applyReactivityEvent(reactivityDb(), () => new Date(), row);

    const after = await getEnrollment(enrollmentId);
    expect(after.status).toBe("cancelled");
    expect(after.outcome).toBe("handoff");
  });

  it("handoff_policy='allow': no-op — enrollment segue intocado", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const contactId = await seedContact(org);
    const conversationId = await seedConversation(org, contactId);
    const { pointerId, versionId } = await seedFlow(org, SIMPLE_GRAPH, { handoffPolicy: "allow" });
    const enrollmentId = await seedEnrollment({ org, pointerId, versionId, contactId, currentNodeId: "w1", status: "active" });
    const before = await getEnrollment(enrollmentId);

    const row = eventRow({
      organization_id: org,
      event_type: "ai.handoff_triggered",
      payload: { conversation_id: conversationId },
    });
    const summary = await applyReactivityEvent(reactivityDb(), () => new Date(), row);
    expect(summary).toEqual({ matched: true, reacted: 0 });

    const after = await getEnrollment(enrollmentId);
    expect(after.status).toBe(before.status);
    expect(after.next_eval_at).toEqual(before.next_eval_at);
  });
});

// ---- 4. O CENTERPIECE anti-Tomik: pausa → fecha → retoma, NUNCA presa ----

describe("applyReactivityEvent — anti-Tomik: paused_handoff SEMPRE tem consumidor de retomada", () => {
  it("handoff abre (pause) → handoff fecha (ai.handoff_resolved) → enrollment retoma pra active com next_eval_at setado", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const contactId = await seedContact(org);
    const conversationId = await seedConversation(org, contactId);
    const { pointerId, versionId } = await seedFlow(org, SIMPLE_GRAPH, { handoffPolicy: "pause" });
    const enrollmentId = await seedEnrollment({ org, pointerId, versionId, contactId, currentNodeId: "w1", status: "active" });

    const db = reactivityDb();
    const openRow = eventRow({
      organization_id: org,
      event_type: "ai.handoff_triggered",
      payload: { conversation_id: conversationId },
    });
    await applyReactivityEvent(db, () => new Date(), openRow);

    const paused = await getEnrollment(enrollmentId);
    expect(paused.status).toBe("paused_handoff");
    expect(paused.next_eval_at).toBeNull(); // sem relógio — só o consumidor de retomada resolve isso

    const beforeResume = Date.now();
    const closeRow = eventRow({
      organization_id: org,
      event_type: "ai.handoff_resolved",
      payload: { conversation_id: conversationId, contact_id: contactId },
    });
    const summary = await applyReactivityEvent(db, () => new Date(), closeRow);
    expect(summary).toEqual({ matched: true, reacted: 1 });

    const resumed = await getEnrollment(enrollmentId);
    expect(resumed.status).toBe("active");
    expect(resumed.next_eval_at).not.toBeNull(); // NUNCA preso — sempre tem relógio de novo
    const nextEvalAt = new Date(resumed.next_eval_at as string).getTime();
    expect(nextEvalAt).toBeGreaterThanOrEqual(beforeResume + RESUME_GRACE_MS - 2_000);
    expect(nextEvalAt).toBeLessThanOrEqual(beforeResume + RESUME_GRACE_MS + 5_000);

    const events = await getEvents(enrollmentId);
    expect(events.map((e) => e.event_type)).toEqual(["handoff_paused", "handoff_resumed"]);

    // e o tick do engine consegue reclamar de verdade depois — não é só o
    // campo, o claim funciona (fn_claim_due_followup_enrollments é global
    // entre orgs, então checamos ESTA linha especificamente, não o count
    // agregado do tick, que pode incluir due-enrollments de OUTROS testes
    // deste arquivo — mesmo comportamento sem isolamento por org da produção).
    await pool.query(`update followup_enrollments set next_eval_at = now() - interval '1 second' where id = $1`, [
      enrollmentId,
    ]);
    expect(resumed.steps_taken).toBe(0); // reactivity nunca mexe em steps_taken (não é passo de grafo)
    await runFollowupTick({ db: engineDb(), clock: () => new Date(), enqueueJob: async () => {} }, { limit: 50 });
    const afterTick = await getEnrollment(enrollmentId);
    expect(Number(afterTick.steps_taken)).toBe(1); // ESTE enrollment foi processado pelo tick de verdade
  });

  it("re-drenar o fechamento (mesmo event_log row) é idempotente — não reagenda 2x", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const contactId = await seedContact(org);
    const conversationId = await seedConversation(org, contactId);
    const { pointerId, versionId } = await seedFlow(org, SIMPLE_GRAPH, { handoffPolicy: "pause" });
    const enrollmentId = await seedEnrollment({ org, pointerId, versionId, contactId, currentNodeId: "w1", status: "active" });

    const db = reactivityDb();
    await applyReactivityEvent(
      db,
      () => new Date(),
      eventRow({ organization_id: org, event_type: "ai.handoff_triggered", payload: { conversation_id: conversationId } }),
    );

    const closeRow = eventRow({
      id: "fixed-close-row",
      organization_id: org,
      event_type: "ai.handoff_resolved",
      payload: { conversation_id: conversationId, contact_id: contactId },
    });
    const s1 = await applyReactivityEvent(db, () => new Date(), closeRow);
    const afterFirst = await getEnrollment(enrollmentId);
    const s2 = await applyReactivityEvent(db, () => new Date(), closeRow);
    const afterSecond = await getEnrollment(enrollmentId);

    expect(s1.reacted).toBe(1);
    expect(s2.reacted).toBe(0); // já não está mais paused_handoff — no LIVE filtro do close
    expect(afterSecond.next_eval_at).toEqual(afterFirst.next_eval_at); // não reagendou de novo
  });
});

// ---- 5. FIX DE REVIEW (Critical) — turn-bridge respeita paused_handoff ----

describe("completeTurnForEnrollment (turn-bridge) — respeita paused_handoff", () => {
  it("classify job em voo quando o handoff pausa: a conclusão tardia é NO-OP — não reativa nem avança por baixo do reactToHandoffClose", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const contactId = await seedContact(org);
    const conversationId = await seedConversation(org, contactId);
    const { pointerId, versionId } = await seedFlow(org, CLASSIFY_GRAPH, { handoffPolicy: "pause" });

    // 1º tick real: entra no ai_classify, enfileira o job de classify (o job
    // "em voo" que o cenário descreve) — status vira waiting_reply.
    const pgDb = createPgAdminClient(pool); // TurnBridgeAdminClient — superset de AdminClient
    const jobs: FollowupJobRequest[] = [];
    const enrollmentId = await seedEnrollment({
      org,
      pointerId,
      versionId,
      contactId,
      currentNodeId: "ac1",
      nextEvalAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const tick1 = await runFollowupTick({ db: pgDb, clock: () => new Date(), enqueueJob: async (j) => void jobs.push(j) }, { limit: 5 });
    expect(tick1.scheduled).toBe(1);
    const afterTick1 = await getEnrollment(enrollmentId);
    expect(afterTick1.status).toBe("waiting_reply");
    expect(afterTick1.current_node_id).toBe("ac1");

    // Handoff abre ANTES do job de classify (ainda em voo) terminar — pausa.
    const reactDb = reactivityDb();
    await applyReactivityEvent(
      reactDb,
      () => new Date(),
      eventRow({ organization_id: org, event_type: "ai.handoff_triggered", payload: { conversation_id: conversationId } }),
    );
    const paused = await getEnrollment(enrollmentId);
    expect(paused.status).toBe("paused_handoff");
    expect(paused.current_node_id).toBe("ac1");

    // O job de classify em voo finalmente completa — resultado STALE (calculado
    // antes do humano intervir). ANTES do fix, o guard de obsolescência só
    // excluía completed/cancelled/dead: current_node_id ainda bate ("ac1"), então
    // isto reativaria e avançaria o enrollment por baixo do handoff. Com o fix
    // (paused_handoff também excluído), é NO-OP.
    await completeTurnForEnrollment(pgDb, org, enrollmentId, "ac1", { kind: "classified", class: "hot" });

    const afterStaleComplete = await getEnrollment(enrollmentId);
    expect(afterStaleComplete.status).toBe("paused_handoff"); // NÃO reativou
    expect(afterStaleComplete.current_node_id).toBe("ac1"); // NÃO avançou pro hot-node
    expect(afterStaleComplete.next_eval_at).toBeNull(); // continua sem relógio — só o close resolve

    // A conclusão stale não deixou nenhum evento 'ai_classified' — o passo
    // nunca foi de fato aplicado (idempotency_key livre pro futuro, se algum
    // dia o mesmo passo precisar ser reprocessado de verdade).
    const eventsWhilePaused = await getEvents(enrollmentId);
    expect(eventsWhilePaused.map((e) => e.event_type)).not.toContain("ai_classified");

    // Handoff fecha — retoma NORMALMENTE (reactToHandoffClose, não o turno stale).
    const closeSummary = await applyReactivityEvent(
      reactDb,
      () => new Date(),
      eventRow({ organization_id: org, event_type: "ai.handoff_resolved", payload: { conversation_id: conversationId, contact_id: contactId } }),
    );
    expect(closeSummary.reacted).toBe(1);

    const resumed = await getEnrollment(enrollmentId);
    expect(resumed.status).toBe("active");
    expect(resumed.current_node_id).toBe("ac1"); // segue no MESMO nó — o resultado stale foi descartado, não aplicado
    expect(resumed.next_eval_at).not.toBeNull();
  });
});
