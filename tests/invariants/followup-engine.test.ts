import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { runFollowupTick, type AdminClient, type FollowupJobRequest, type TickDeps } from "@/lib/followup/engine";
import { flowGraphSchema, type FlowGraph } from "@/lib/followup/graph-schema";
import type { EnrollmentEventRef, EnrollmentRow } from "@/lib/followup/node-handlers";

/**
 * Task 4.1 — motor do worker de follow-up (tick + node-handlers) contra
 * Postgres real (baseline aplicado, inclui o apêndice 0054/0057).
 *
 * Este arquivo roda contra o Postgres cru do test-db.sh (sem PostgREST — ver
 * vitest.db.config.ts, que aponta NEXT_PUBLIC_SUPABASE_URL pra uma porta
 * inalcançável de propósito). `AdminClient` é uma interface própria do
 * engine (não `SupabaseClient`) exatamente pra isso: aqui o adapter fala
 * `pg` puro; em produção, `createSupabaseAdminClient` (engine.ts) fala REST.
 *
 * Congela: (1) tick avança 1 nó por tick; (2) ciclo de wait (start→elapse);
 * (3) idempotência de evento sob replay (mesmo idempotency_key, 2ª aplicação
 * não reenfileira job); (4) progressão de backoff; (5) dead + inbox item;
 * (6) max_steps.
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

// ---- pg-backed AdminClient (test-only adapter; prod uses createSupabaseAdminClient) ----

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

function pgAdminClient(): AdminClient {
  return {
    async claimDueEnrollments(limit, leaseSeconds) {
      const { rows } = await pool.query(`select * from fn_claim_due_followup_enrollments($1, $2)`, [
        limit,
        leaseSeconds,
      ]);
      return rows.map(mapEnrollmentRow);
    },
    async loadFlowGraph(orgId, versionId): Promise<FlowGraph | null> {
      const { rows } = await pool.query<{ graph: unknown }>(
        `select graph from followup_flow_versions where organization_id = $1 and id = $2`,
        [orgId, versionId],
      );
      if (rows.length === 0) return null;
      return flowGraphSchema.parse(rows[0]!.graph);
    },
    async loadLeadFacts(orgId, contactId) {
      const { rows } = await pool.query<{ stage_id: string | null; tags: string[] }>(
        `select stage_id, tags from crm_leads where organization_id = $1 and contact_id = $2
         order by updated_at desc limit 1`,
        [orgId, contactId],
      );
      if (rows.length === 0) return { lead_stage: null, tags: [] };
      return { lead_stage: rows[0]!.stage_id, tags: rows[0]!.tags };
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

async function seedOrg(org: string): Promise<void> {
  const name = `followup-engine-${org.slice(0, 8)}`;
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1, $2, $3, $4) on conflict (id) do nothing`,
    [org, name, name, name],
  );
}

async function seedContact(org: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, display_name) values ($1, 'Followup Engine Contact') returning id`,
    [org],
  );
  return rows[0]!.id;
}

async function seedFlow(org: string, graph: FlowGraph): Promise<{ pointerId: string; versionId: string }> {
  const { rows: versionRows } = await pool.query<{ id: string }>(
    `insert into followup_flow_versions (organization_id, graph) values ($1, $2) returning id`,
    [org, JSON.stringify(graph)],
  );
  const versionId = versionRows[0]!.id;
  const { rows: pointerRows } = await pool.query<{ id: string }>(
    `insert into followup_flow_pointers (organization_id, name, status, active_version_id)
     values ($1, $2, 'active', $3) returning id`,
    [org, `Engine Flow ${Date.now()}-${Math.random()}`, versionId],
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
  nextEvalAt?: string; // SQL expression, defaults to "now() - interval '1 second'" (due)
  stepsTaken?: number;
  attempts?: number;
  maxAttempts?: number;
}): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into followup_enrollments
       (organization_id, pointer_id, version_id, contact_id, current_node_id, status, next_eval_at, steps_taken, attempts, max_attempts)
     values ($1, $2, $3, $4, $5, $6, ${params.nextEvalAt ?? "now() - interval '1 second'"}, $7, $8, $9)
     returning id`,
    [
      params.org,
      params.pointerId,
      params.versionId,
      params.contactId,
      params.currentNodeId,
      params.status ?? "active",
      params.stepsTaken ?? 0,
      params.attempts ?? 0,
      params.maxAttempts ?? 5,
    ],
  );
  return rows[0]!.id;
}

async function getEnrollment(id: string): Promise<Record<string, unknown>> {
  const { rows } = await pool.query(`select * from followup_enrollments where id = $1`, [id]);
  return rows[0]!;
}

function makeDeps(jobs: FollowupJobRequest[]): TickDeps {
  return {
    db: pgAdminClient(),
    clock: () => new Date(),
    enqueueJob: async (job) => {
      jobs.push(job);
    },
  };
}

// ---- graphs ----

const TWO_NODE_GRAPH: FlowGraph = {
  nodes: [
    { id: "t1", type: "trigger", label: "Start", position: { x: 0, y: 0 }, config: {} },
    { id: "e1", type: "end", label: "Done", position: { x: 0, y: 0 }, config: { outcome: "converted" } },
  ],
  edges: [{ id: "t1-e1", source: "t1", target: "e1", priority: 0, condition: { type: "always" } }],
};

const WAIT_GRAPH: FlowGraph = {
  nodes: [
    { id: "t1", type: "trigger", label: "Start", position: { x: 0, y: 0 }, config: {} },
    {
      id: "w1",
      type: "wait",
      label: "Wait",
      position: { x: 0, y: 0 },
      config: { mode: "fixed", duration_ms: 300_000 },
    },
    { id: "e1", type: "end", label: "Done", position: { x: 0, y: 0 }, config: { outcome: "converted" } },
  ],
  edges: [
    { id: "t1-w1", source: "t1", target: "w1", priority: 0, condition: { type: "always" } },
    { id: "w1-e1", source: "w1", target: "e1", priority: 0, condition: { type: "always" } },
  ],
};

const ACTION_GRAPH: FlowGraph = {
  nodes: [
    { id: "t1", type: "trigger", label: "Start", position: { x: 0, y: 0 }, config: {} },
    {
      id: "a1",
      type: "action",
      label: "Send",
      position: { x: 0, y: 0 },
      config: { mode: "ai_message", prompt_hint: "lembre o lead da proposta" },
    },
  ],
  edges: [{ id: "t1-a1", source: "t1", target: "a1", priority: 0, condition: { type: "always" } }],
};

beforeAll(async () => {
  // flowGraphSchema exige >=2 nós — os 3 grafos fixos acima já satisfazem isso;
  // valida aqui uma vez pra falhar cedo (erro de fixture, não de asserção).
  flowGraphSchema.parse(TWO_NODE_GRAPH);
  flowGraphSchema.parse(WAIT_GRAPH);
  flowGraphSchema.parse(ACTION_GRAPH);
});

// ---- 1. tick avança 1 nó por tick ---------------------------------------

describe("runFollowupTick — avança 1 nó por tick", () => {
  it("trigger → end leva 2 ticks (1 avanço de nó por tick)", async () => {
    const org = "aaaaaaa1-0000-4000-8000-000000000001";
    await seedOrg(org);
    const contactId = await seedContact(org);
    const { pointerId, versionId } = await seedFlow(org, TWO_NODE_GRAPH);
    const enrollmentId = await seedEnrollment({ org, pointerId, versionId, contactId, currentNodeId: "t1" });

    const jobs: FollowupJobRequest[] = [];
    const summary1 = await runFollowupTick(makeDeps(jobs), { limit: 5 });
    expect(summary1.claimed).toBe(1);
    expect(summary1.advanced).toBe(1);

    const afterTick1 = await getEnrollment(enrollmentId);
    expect(afterTick1.current_node_id).toBe("e1");
    expect(afterTick1.status).toBe("active");
    expect(afterTick1.steps_taken).toBe(1);

    const summary2 = await runFollowupTick(makeDeps(jobs), { limit: 5 });
    expect(summary2.claimed).toBeGreaterThanOrEqual(1);
    expect(summary2.advanced).toBeGreaterThanOrEqual(1);

    const afterTick2 = await getEnrollment(enrollmentId);
    expect(afterTick2.status).toBe("completed");
    expect(afterTick2.outcome).toBe("converted");
    expect(afterTick2.next_eval_at).toBeNull();
    expect(afterTick2.steps_taken).toBe(2);
  });
});

// ---- 2. ciclo de wait: start → elapse -----------------------------------

describe("runFollowupTick — ciclo de wait (start → elapse)", () => {
  it("1º tick no wait agenda e permanece; 2º (após elapse) avança", async () => {
    const org = "aaaaaaa2-0000-4000-8000-000000000001";
    await seedOrg(org);
    const contactId = await seedContact(org);
    const { pointerId, versionId } = await seedFlow(org, WAIT_GRAPH);
    // já entra direto no nó wait (pula o trigger — não é o foco deste teste)
    const enrollmentId = await seedEnrollment({ org, pointerId, versionId, contactId, currentNodeId: "w1" });

    const jobs: FollowupJobRequest[] = [];
    const summary1 = await runFollowupTick(makeDeps(jobs), { limit: 5 });
    expect(summary1.claimed).toBe(1);
    expect(summary1.scheduled).toBe(1);

    const afterStart = await getEnrollment(enrollmentId);
    expect(afterStart.current_node_id).toBe("w1"); // continua no mesmo nó
    expect(afterStart.status).toBe("active");
    const nextEvalAt = new Date(afterStart.next_eval_at as string);
    expect(nextEvalAt.getTime()).toBeGreaterThan(Date.now() + 250_000); // ~5min à frente

    // simula o relógio andando: reclaimable AGORA sem esperar 5min de verdade
    await pool.query(`update followup_enrollments set next_eval_at = now() - interval '1 second' where id = $1`, [
      enrollmentId,
    ]);

    const summary2 = await runFollowupTick(makeDeps(jobs), { limit: 5 });
    expect(summary2.claimed).toBeGreaterThanOrEqual(1);
    expect(summary2.advanced).toBeGreaterThanOrEqual(1);

    const afterElapse = await getEnrollment(enrollmentId);
    expect(afterElapse.current_node_id).toBe("e1");
    expect(afterElapse.steps_taken).toBe(2);
  });
});

// ---- 3. idempotência de evento sob replay -------------------------------

describe("runFollowupTick — idempotência de evento (replay não reenfileira)", () => {
  it("reaplicar o mesmo passo (idempotency_key repetida) não chama enqueueJob de novo", async () => {
    const org = "aaaaaaa3-0000-4000-8000-000000000001";
    await seedOrg(org);
    const contactId = await seedContact(org);
    const { pointerId, versionId } = await seedFlow(org, ACTION_GRAPH);
    const enrollmentId = await seedEnrollment({ org, pointerId, versionId, contactId, currentNodeId: "a1" });

    const jobs: FollowupJobRequest[] = [];
    const summary1 = await runFollowupTick(makeDeps(jobs), { limit: 5 });
    expect(summary1.scheduled).toBe(1);
    expect(jobs).toHaveLength(1);

    const afterTick1 = await getEnrollment(enrollmentId);
    expect(afterTick1.status).toBe("active"); // action → wake_status 'active'
    expect(afterTick1.steps_taken).toBe(1);

    // Simula reprocessamento do MESMO passo (ex.: crash entre o insert do
    // evento e o update do enrollment): reverte steps_taken e reabre o claim
    // sem tocar no evento já gravado — a 2ª aplicação bate no mesmo
    // idempotency_key `${node_id}:${steps_taken}`.
    await pool.query(
      `update followup_enrollments set steps_taken = 0, next_eval_at = now() - interval '1 second', claimed_until = null where id = $1`,
      [enrollmentId],
    );

    const summary2 = await runFollowupTick(makeDeps(jobs), { limit: 5 });
    expect(summary2.claimed).toBe(1);
    // side effect NÃO duplicado — a doutrina at-most-once do envio
    expect(jobs).toHaveLength(1);

    const afterReplay = await getEnrollment(enrollmentId);
    expect(afterReplay.steps_taken).toBe(1); // convergiu pro mesmo estado alvo
    expect(afterReplay.status).toBe("active");

    const { rows: eventRows } = await pool.query(
      `select count(*) as n from followup_enrollment_events where enrollment_id = $1`,
      [enrollmentId],
    );
    expect(Number(eventRows[0].n)).toBe(1); // só 1 evento — o insert duplicado foi 23505
  });
});

// ---- 4-5. progressão de backoff + dead + inbox item ---------------------

describe("runFollowupTick — backoff progride e esgota em 'dead' + inbox item", () => {
  it("current_node_id inexistente falha todo tick; attempts sobe pelo BACKOFF_MS até 'dead'", async () => {
    const org = "aaaaaaa4-0000-4000-8000-000000000001";
    await seedOrg(org);
    const contactId = await seedContact(org);
    const { pointerId, versionId } = await seedFlow(org, TWO_NODE_GRAPH);
    const enrollmentId = await seedEnrollment({
      org,
      pointerId,
      versionId,
      contactId,
      currentNodeId: "ghost-node", // não existe no grafo → node_not_found em todo tick
      maxAttempts: 2,
    });

    const jobs: FollowupJobRequest[] = [];

    const s1 = await runFollowupTick(makeDeps(jobs), { limit: 5 });
    expect(s1.failed).toBe(1);
    let row = await getEnrollment(enrollmentId);
    expect(row.attempts).toBe(1);
    expect(row.status).toBe("active");
    expect(row.last_error).toBeTruthy();

    // força o vencimento pra não depender de esperar o backoff real (até 1h)
    await pool.query(`update followup_enrollments set next_eval_at = now() - interval '1 second' where id = $1`, [
      enrollmentId,
    ]);
    const s2 = await runFollowupTick(makeDeps(jobs), { limit: 5 });
    expect(s2.failed).toBe(1);
    row = await getEnrollment(enrollmentId);
    expect(row.attempts).toBe(2);
    expect(row.status).toBe("active"); // max_attempts=2, ainda não passou

    await pool.query(`update followup_enrollments set next_eval_at = now() - interval '1 second' where id = $1`, [
      enrollmentId,
    ]);
    const s3 = await runFollowupTick(makeDeps(jobs), { limit: 5 });
    expect(s3.dead).toBe(1);
    row = await getEnrollment(enrollmentId);
    expect(row.attempts).toBe(3);
    expect(row.status).toBe("dead");
    expect(row.cancel_reason).toBeTruthy();
    expect(row.next_eval_at).toBeNull();

    const { rows: inboxRows } = await pool.query(
      `select kind, ref_id from agent_inbox_items where organization_id = $1 and kind = 'followup_dead'`,
      [org],
    );
    expect(inboxRows).toHaveLength(1);
    expect(inboxRows[0].ref_id).toBe(enrollmentId);
  });
});

// ---- 6. max_steps ---------------------------------------------------------

describe("runFollowupTick — max_steps", () => {
  it("steps_taken > 30 mata o enrollment sem sequer carregar o grafo", async () => {
    const org = "aaaaaaa5-0000-4000-8000-000000000001";
    await seedOrg(org);
    const contactId = await seedContact(org);
    const { pointerId, versionId } = await seedFlow(org, TWO_NODE_GRAPH);
    const enrollmentId = await seedEnrollment({
      org,
      pointerId,
      versionId,
      contactId,
      currentNodeId: "t1",
      stepsTaken: 31,
    });

    const jobs: FollowupJobRequest[] = [];
    const summary = await runFollowupTick(makeDeps(jobs), { limit: 5 });
    expect(summary.dead).toBe(1);

    const row = await getEnrollment(enrollmentId);
    expect(row.status).toBe("dead");
    expect(row.cancel_reason).toBe("max_steps");
    expect(row.next_eval_at).toBeNull();

    const { rows: inboxRows } = await pool.query(
      `select kind from agent_inbox_items where organization_id = $1 and kind = 'followup_dead'`,
      [org],
    );
    expect(inboxRows).toHaveLength(1);
  });
});
