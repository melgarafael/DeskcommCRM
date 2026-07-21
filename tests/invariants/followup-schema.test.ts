import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { sql, countAs } from "./gov-helpers";

/**
 * Task 1.2 — invariantes de schema do sistema de follow-up (migration 0054).
 *
 * Roda contra o Postgres efêmero do test-db.sh (baseline aplicado — inclui o
 * apêndice 0054). Congela:
 *   1. RLS: usuário da org A lê 0 rows da org B nas 4 tabelas followup_*;
 *   2. unique: só 1 enrollment "vivo" (active/waiting_reply/paused_handoff)
 *      por (pointer_id, contact_id) — 23505 no 2º; libera após completar o 1º;
 *   3. unique: idempotency_key duplicada no mesmo enrollment_id → 23505;
 *   4. check: enrollment 'active' sem next_eval_at → 23514;
 *   5. concorrência: fn_claim_due_followup_enrollments em 2 conexões
 *      simultâneas nunca devolve o mesmo id nas duas.
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

// ---- Caso 1: RLS 2-tenant isolation ---------------------------------------

const ORG_A = "99999999-0000-4000-8000-000000000001";
const ORG_B = "99999999-0000-4000-8000-000000000002";
const USER_A = "99999999-1111-4000-8000-000000000001";
const USER_B = "99999999-1111-4000-8000-000000000002";
const CONTACT_A = "99999999-2222-4000-8000-000000000001";
const CONTACT_B = "99999999-2222-4000-8000-000000000002";
const VERSION_A = "99999999-3333-4000-8000-000000000001";
const VERSION_B = "99999999-3333-4000-8000-000000000002";
const POINTER_A = "99999999-4444-4000-8000-000000000001";
const POINTER_B = "99999999-4444-4000-8000-000000000002";
const ENROLLMENT_A = "99999999-5555-4000-8000-000000000001";
const ENROLLMENT_B = "99999999-5555-4000-8000-000000000002";
const EVENT_A = "99999999-6666-4000-8000-000000000001";
const EVENT_B = "99999999-6666-4000-8000-000000000002";

function seedRlsOrg(
  org: string,
  user: string,
  contact: string,
  version: string,
  pointer: string,
  enrollment: string,
  event: string,
  tag: string,
): string {
  // No real PII: dados sintéticos apenas (LGPD).
  return `
    insert into auth.users (id, email) values ('${user}', 'followup-rls-${tag}@invariant.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${org}', 'followup-rls-${tag}', 'Followup RLS ${tag}', 'Followup RLS ${tag}')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${user}', '${org}', 'agent', now())
      on conflict do nothing;
    insert into public.contacts (id, organization_id, display_name)
      values ('${contact}', '${org}', 'Followup RLS Contact ${tag}')
      on conflict (id) do nothing;
    insert into public.followup_flow_versions (id, organization_id, graph)
      values ('${version}', '${org}', '{}'::jsonb)
      on conflict (id) do nothing;
    insert into public.followup_flow_pointers (id, organization_id, name, status, active_version_id)
      values ('${pointer}', '${org}', 'Followup RLS Flow ${tag}', 'active', '${version}')
      on conflict (id) do nothing;
    insert into public.followup_enrollments (id, organization_id, pointer_id, version_id, contact_id, current_node_id, status, next_eval_at)
      values ('${enrollment}', '${org}', '${pointer}', '${version}', '${contact}', 'start', 'active', now())
      on conflict (id) do nothing;
    insert into public.followup_enrollment_events (id, organization_id, enrollment_id, event_type, payload)
      values ('${event}', '${org}', '${enrollment}', 'rls_probe', '{}'::jsonb)
      on conflict (id) do nothing;
  `;
}

beforeAll(() => {
  sql(
    seedRlsOrg(ORG_A, USER_A, CONTACT_A, VERSION_A, POINTER_A, ENROLLMENT_A, EVENT_A, "a") +
      seedRlsOrg(ORG_B, USER_B, CONTACT_B, VERSION_B, POINTER_B, ENROLLMENT_B, EVENT_B, "b"),
  );
});

const FOLLOWUP_TABLES = [
  "followup_flow_versions",
  "followup_flow_pointers",
  "followup_enrollments",
  "followup_enrollment_events",
] as const;

describe("followup schema (0054) — RLS tenant isolation", () => {
  for (const table of FOLLOWUP_TABLES) {
    it(`user of org A reads 0 rows of org B in ${table}`, () => {
      const crossTenant = countAs(
        USER_A,
        `select count(*) from public.${table} where organization_id = '${ORG_B}';`,
      );
      expect(crossTenant).toBe(0);
    });

    it(`user of org A still reads their own org rows in ${table} (positive control)`, () => {
      const ownRows = countAs(
        USER_A,
        `select count(*) from public.${table} where organization_id = '${ORG_A}';`,
      );
      expect(ownRows).toBeGreaterThanOrEqual(1);
    });
  }
});

// ---- Casos 2-5: constraints + concorrência (via pg, precisa de código de erro) --

async function seedFlow(org: string): Promise<{ pointerId: string; versionId: string }> {
  const orgTag = `followup-inv-${org}`;
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, $2, $3, $4) on conflict (id) do nothing`,
    [org, orgTag, orgTag, orgTag],
  );
  const { rows: versionRows } = await pool.query<{ id: string }>(
    `insert into followup_flow_versions (organization_id, graph) values ($1, '{}'::jsonb) returning id`,
    [org],
  );
  const versionId = versionRows[0]!.id;
  const { rows: pointerRows } = await pool.query<{ id: string }>(
    `insert into followup_flow_pointers (organization_id, name, status, active_version_id)
     values ($1, $2, 'active', $3) returning id`,
    [org, `Flow ${org.slice(0, 8)}-${Date.now()}-${Math.random()}`, versionId],
  );
  return { pointerId: pointerRows[0]!.id, versionId };
}

async function seedContact(org: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, display_name) values ($1, 'Followup Invariant Contact') returning id`,
    [org],
  );
  return rows[0]!.id;
}

const ORG_UNIQUE = "99999999-7777-4000-8000-000000000001";
const ORG_IDEM = "99999999-7777-4000-8000-000000000002";
const ORG_CHECK = "99999999-7777-4000-8000-000000000003";
const ORG_CLAIM = "99999999-7777-4000-8000-000000000004";

describe("followup schema (0054) — unique: 1 enrollment vivo por (pointer, contact)", () => {
  it("2º enrollment vivo do mesmo (pointer, contact) → 23505; libera após completar o 1º", async () => {
    const { pointerId, versionId } = await seedFlow(ORG_UNIQUE);
    const contactId = await seedContact(ORG_UNIQUE);

    const { rows: first } = await pool.query<{ id: string }>(
      `insert into followup_enrollments (organization_id, pointer_id, version_id, contact_id, current_node_id, status, next_eval_at)
       values ($1, $2, $3, $4, 'start', 'active', now()) returning id`,
      [ORG_UNIQUE, pointerId, versionId, contactId],
    );
    expect(first).toHaveLength(1);

    await expect(
      pool.query(
        `insert into followup_enrollments (organization_id, pointer_id, version_id, contact_id, current_node_id, status, next_eval_at)
         values ($1, $2, $3, $4, 'start', 'waiting_reply', now())`,
        [ORG_UNIQUE, pointerId, versionId, contactId],
      ),
    ).rejects.toMatchObject({ code: "23505" });

    await pool.query(`update followup_enrollments set status = 'completed', completed_at = now() where id = $1`, [
      first[0]!.id,
    ]);

    const { rows: second } = await pool.query<{ id: string }>(
      `insert into followup_enrollments (organization_id, pointer_id, version_id, contact_id, current_node_id, status, next_eval_at)
       values ($1, $2, $3, $4, 'start', 'active', now()) returning id`,
      [ORG_UNIQUE, pointerId, versionId, contactId],
    );
    expect(second).toHaveLength(1);
  });
});

describe("followup schema (0054) — unique: idempotency_key por enrollment", () => {
  it("2º evento com mesmo (enrollment_id, idempotency_key) → 23505", async () => {
    const { pointerId, versionId } = await seedFlow(ORG_IDEM);
    const contactId = await seedContact(ORG_IDEM);
    const { rows: enrollment } = await pool.query<{ id: string }>(
      `insert into followup_enrollments (organization_id, pointer_id, version_id, contact_id, current_node_id, status, next_eval_at)
       values ($1, $2, $3, $4, 'start', 'active', now()) returning id`,
      [ORG_IDEM, pointerId, versionId, contactId],
    );
    const enrollmentId = enrollment[0]!.id;

    await pool.query(
      `insert into followup_enrollment_events (organization_id, enrollment_id, event_type, idempotency_key)
       values ($1, $2, 'node_entered', 'dedupe-key-1')`,
      [ORG_IDEM, enrollmentId],
    );

    await expect(
      pool.query(
        `insert into followup_enrollment_events (organization_id, enrollment_id, event_type, idempotency_key)
         values ($1, $2, 'node_entered', 'dedupe-key-1')`,
        [ORG_IDEM, enrollmentId],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });
});

describe("followup schema (0054) — check: active exige next_eval_at", () => {
  it("enrollment 'active' sem next_eval_at → 23514", async () => {
    const { pointerId, versionId } = await seedFlow(ORG_CHECK);
    const contactId = await seedContact(ORG_CHECK);

    await expect(
      pool.query(
        `insert into followup_enrollments (organization_id, pointer_id, version_id, contact_id, current_node_id, status, next_eval_at)
         values ($1, $2, $3, $4, 'start', 'active', null)`,
        [ORG_CHECK, pointerId, versionId, contactId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

describe("followup schema (0054) — fn_claim_due_followup_enrollments concorrência", () => {
  it("2 conexões concorrentes pedindo limit 5 não retornam o mesmo id (união = 5, sem interseção)", async () => {
    const { pointerId, versionId } = await seedFlow(ORG_CLAIM);
    const contactIds = await Promise.all(Array.from({ length: 5 }, () => seedContact(ORG_CLAIM)));

    // fn_claim_due_followup_enrollments não filtra por org (fila global do
    // worker) — outros testes deste arquivo também deixam enrollments 'active'
    // vencidos no banco. Para não depender do total global (shared state entre
    // arquivos, ver vitest.db.config.ts), ancoramos nos 5 ids que ESTE teste
    // seedou (next_eval_at mais antigo que qualquer leftover: entram primeiro
    // no `order by next_eval_at`).
    const myIds = new Set<string>();
    for (const contactId of contactIds) {
      const { rows } = await pool.query<{ id: string }>(
        `insert into followup_enrollments (organization_id, pointer_id, version_id, contact_id, current_node_id, status, next_eval_at)
         values ($1, $2, $3, $4, 'start', 'active', now() - interval '1 minute') returning id`,
        [ORG_CLAIM, pointerId, versionId, contactId],
      );
      myIds.add(rows[0]!.id);
    }

    const [resultA, resultB] = await Promise.all([
      pool.query<{ id: string }>(`select * from fn_claim_due_followup_enrollments($1, $2)`, [5, 300]),
      pool.query<{ id: string }>(`select * from fn_claim_due_followup_enrollments($1, $2)`, [5, 300]),
    ]);

    const idsA = resultA.rows.map((r) => r.id).filter((id) => myIds.has(id));
    const idsB = resultB.rows.map((r) => r.id).filter((id) => myIds.has(id));
    const intersection = idsA.filter((id) => idsB.includes(id));

    expect(intersection).toHaveLength(0);
    expect(new Set([...idsA, ...idsB]).size).toBe(5);
  });
});
