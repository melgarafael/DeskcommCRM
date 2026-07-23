import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";

import { aggregateFollowupOutcomes } from "@/lib/followup/outcome-stats";

/**
 * Task 8.2 — agregação de outcomes de follow-up por fluxo (pointer+version),
 * contra Postgres real. DESKCOMM_GOV_INVARIANTS_EDIT=1 — arquivo NOVO desta
 * sessão (tests/invariants/** congelado só pra arquivos existentes).
 *
 * Congela: (1) contadores por outcome + in_flight corretos com mix real de
 * status/outcome (incluindo cancelamento manual sem outcome e `dead`, que
 * NÃO conta como terminal — ver header de outcome-stats.ts); (2) mesmo
 * pointer com 2 versions vira 2 linhas separadas (GROUP BY pointer_id,
 * version_id); (3) conversion_rate = converted/terminal, `null` quando
 * terminal = 0 (nenhum enrollment terminou ainda); (4) isolamento cross-org —
 * a query já filtra `organization_id` no WHERE, então cada teste usa um org
 * id próprio (`nextOrgId`) em vez de `beforeEach` de limpeza global (a
 * classe de flake documentada nas Tasks 5.2/8.1 é de funções que escaneiam
 * SEM filtro de org — não é o caso aqui).
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

// ---- seed helpers ----

let orgSeq = 0;
function nextOrgId(): string {
  orgSeq += 1;
  return `eeeeee${String(orgSeq).padStart(2, "0")}-0000-4000-8000-000000000001`;
}

async function seedOrg(org: string): Promise<void> {
  const name = `followup-outcome-${org.slice(0, 8)}`;
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1, $2, $3, $4) on conflict (id) do nothing`,
    [org, name, name, name],
  );
}

async function seedContact(org: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, display_name) values ($1, 'Outcome Stats Contact') returning id`,
    [org],
  );
  return rows[0]!.id;
}

async function seedPointer(org: string, name: string, activeVersionId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into followup_flow_pointers (organization_id, name, status, active_version_id)
     values ($1, $2, 'active', $3) returning id`,
    [org, name, activeVersionId],
  );
  return rows[0]!.id;
}

async function seedVersion(org: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into followup_flow_versions (organization_id, graph) values ($1, '{}'::jsonb) returning id`,
    [org],
  );
  return rows[0]!.id;
}

// `idx_followup_enrollments_one_live` (pointer_id, contact_id) só permite 1
// enrollment VIVO (active/waiting_reply/paused_handoff) por par pointer+contato —
// então cada linha ganha o SEU PRÓPRIO contato (barato, sem custar realismo do
// teste: o agregador nem olha contact_id).
async function seedEnrollment(params: {
  org: string;
  pointerId: string;
  versionId: string;
  status: "active" | "waiting_reply" | "paused_handoff" | "completed" | "cancelled" | "dead";
  outcome: "converted" | "replied" | "exhausted" | "opted_out" | "handoff" | null;
}): Promise<void> {
  const contactId = await seedContact(params.org);
  const isLive = params.status === "active" || params.status === "waiting_reply";
  await pool.query(
    `insert into followup_enrollments
       (organization_id, pointer_id, version_id, contact_id, current_node_id, status, next_eval_at, outcome)
     values ($1, $2, $3, $4, 'n1', $5, ${isLive ? "now() + interval '1 hour'" : "null"}, $6)`,
    [params.org, params.pointerId, params.versionId, contactId, params.status, params.outcome],
  );
}

describe("aggregateFollowupOutcomes", () => {
  it("aggrega contadores + conversion_rate por pointer/version, isolando org e excluindo dead do terminal", async () => {
    const orgA = nextOrgId();
    const orgB = nextOrgId();
    await seedOrg(orgA);
    await seedOrg(orgB);

    // pointer1/v1 (Flow A): mix completo — 2 converted, 1 replied, 1 exhausted,
    // 1 opted_out, 1 handoff, 2 in_flight (active+waiting_reply), 1 cancelamento
    // manual (outcome null), 1 dead. total=10, terminal=7 (3 completed + 4 cancelled).
    const v1 = await seedVersion(orgA);
    const pointer1 = await seedPointer(orgA, "Flow A", v1);
    await seedEnrollment({ org: orgA, pointerId: pointer1, versionId: v1, status: "completed", outcome: "converted" });
    await seedEnrollment({ org: orgA, pointerId: pointer1, versionId: v1, status: "completed", outcome: "converted" });
    await seedEnrollment({ org: orgA, pointerId: pointer1, versionId: v1, status: "cancelled", outcome: "replied" });
    await seedEnrollment({ org: orgA, pointerId: pointer1, versionId: v1, status: "completed", outcome: "exhausted" });
    await seedEnrollment({ org: orgA, pointerId: pointer1, versionId: v1, status: "cancelled", outcome: "opted_out" });
    await seedEnrollment({ org: orgA, pointerId: pointer1, versionId: v1, status: "cancelled", outcome: "handoff" });
    await seedEnrollment({ org: orgA, pointerId: pointer1, versionId: v1, status: "active", outcome: null });
    await seedEnrollment({ org: orgA, pointerId: pointer1, versionId: v1, status: "waiting_reply", outcome: null });
    await seedEnrollment({ org: orgA, pointerId: pointer1, versionId: v1, status: "cancelled", outcome: null }); // cancelamento manual
    await seedEnrollment({ org: orgA, pointerId: pointer1, versionId: v1, status: "dead", outcome: null });

    // MESMO pointer, v2 (republicação): 1 converted, 1 dead. terminal=1, conv_rate=1.
    const v2 = await seedVersion(orgA);
    await seedEnrollment({ org: orgA, pointerId: pointer1, versionId: v2, status: "completed", outcome: "converted" });
    await seedEnrollment({ org: orgA, pointerId: pointer1, versionId: v2, status: "dead", outcome: null });

    // pointer2/v3 (Flow B): tudo in_flight, zero terminal → conversion_rate null.
    const v3 = await seedVersion(orgA);
    const pointer2 = await seedPointer(orgA, "Flow B", v3);
    await seedEnrollment({ org: orgA, pointerId: pointer2, versionId: v3, status: "active", outcome: null });
    await seedEnrollment({ org: orgA, pointerId: pointer2, versionId: v3, status: "active", outcome: null });
    await seedEnrollment({ org: orgA, pointerId: pointer2, versionId: v3, status: "waiting_reply", outcome: null });

    // org B: pointer3/v4 — 5 converted, terminal=5, conversion_rate=1. Prova de isolamento.
    const v4 = await seedVersion(orgB);
    const pointer3 = await seedPointer(orgB, "Flow C", v4);
    for (let i = 0; i < 5; i++) {
      await seedEnrollment({ org: orgB, pointerId: pointer3, versionId: v4, status: "completed", outcome: "converted" });
    }

    const statsA = await aggregateFollowupOutcomes(pool, orgA);
    expect(statsA).toHaveLength(3);

    const flowAv1 = statsA.find((s) => s.pointer_id === pointer1 && s.version_id === v1);
    expect(flowAv1).toBeDefined();
    expect(flowAv1!.flow_name).toBe("Flow A");
    expect(flowAv1!.counts).toEqual({
      converted: 2,
      replied: 1,
      exhausted: 1,
      opted_out: 1,
      handoff: 1,
      in_flight: 2,
    });
    expect(flowAv1!.total).toBe(10);
    expect(flowAv1!.conversion_rate).toBeCloseTo(2 / 7);

    const flowAv2 = statsA.find((s) => s.pointer_id === pointer1 && s.version_id === v2);
    expect(flowAv2).toBeDefined();
    expect(flowAv2!.counts.converted).toBe(1);
    expect(flowAv2!.total).toBe(2);
    expect(flowAv2!.conversion_rate).toBe(1);

    const flowB = statsA.find((s) => s.pointer_id === pointer2 && s.version_id === v3);
    expect(flowB).toBeDefined();
    expect(flowB!.flow_name).toBe("Flow B");
    expect(flowB!.counts.in_flight).toBe(3);
    expect(flowB!.total).toBe(3);
    expect(flowB!.conversion_rate).toBeNull(); // divisão por zero — zero terminal

    // isolamento: org A nunca vê o fluxo de org B, e vice-versa.
    expect(statsA.some((s) => s.pointer_id === pointer3)).toBe(false);

    const statsB = await aggregateFollowupOutcomes(pool, orgB);
    expect(statsB).toHaveLength(1);
    expect(statsB[0]!.pointer_id).toBe(pointer3);
    expect(statsB[0]!.flow_name).toBe("Flow C");
    expect(statsB[0]!.counts.converted).toBe(5);
    expect(statsB[0]!.total).toBe(5);
    expect(statsB[0]!.conversion_rate).toBe(1);
    expect(statsB.some((s) => s.pointer_id === pointer1 || s.pointer_id === pointer2)).toBe(false);
  });

  it("retorna array vazio pra org sem nenhum enrollment de follow-up", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const stats = await aggregateFollowupOutcomes(pool, org);
    expect(stats).toEqual([]);
  });
});
