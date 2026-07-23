import { afterAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import {
  runSilenceSweep,
  type SilenceSweepDb,
  type SilencePointer,
} from "@/lib/followup/silence-sweep";
import { isPointerEnabledForAutomaticTrigger, type FollowupGateDb } from "@/lib/followup/agent-followup-gate";
import type { FlowGraph } from "@/lib/followup/graph-schema";

/**
 * Task 8.1 — gatilho de silêncio (varredura TIME-DRIVEN no cron) contra
 * Postgres real. DESKCOMM_GOV_INVARIANTS_EDIT=1 — arquivo NOVO desta sessão
 * (tests/invariants/** está congelado pro resto, não para arquivos próprios).
 *
 * Congela: (1) pointer silence habilitado no gate + contato silêncio >
 * threshold → exatamente 1 enrollment nascendo no nó trigger; rodar a
 * varredura DE NOVO não duplica (unique-live, `idx_followup_enrollments_one_live`);
 * (2) o MESMO cenário mas SEM nenhum agente publicado habilitando o pointer →
 * 0 enrollments (prova que o gate é de fato chamado, não só importado);
 * (3) contato silencioso HÁ MENOS que o threshold → não enrolla (boundary);
 * (4) `isPointerEnabledForAutomaticTrigger` contra `ai_agent_versions` REAL
 * (não o fake hand-rolled de agent-followup-gate.test.ts): publicado+
 * habilitado+pointer-membro → true; rascunho (não publicado) → false;
 * enabled=false → false; pointer de OUTRA org → false (reviewer Minor #2 da
 * Task 7.2 — a task que primeiro CONSOME o gate é quem prova a query real).
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

// `loadActiveSilencePointers` é GLOBAL (cross-org, mesmo desenho de
// `fn_claim_due_followup_enrollments`) — um pointer kind='silence' de um `it`
// anterior (status='active' pra sempre, nada o desativa) seria re-escaneado
// pelo `it` seguinte e contaminaria pointers_scanned/pointers_gated_out (mesma
// classe de flake já resolvida em followup-engine.test.ts, Task 5.2 fix 2).
// Escopo do delete: só kind='silence' — não toca pointers de OUTROS arquivos
// (reactivity/engine/turn-bridge nunca usam kind='silence'). Cascade:
// `followup_enrollments.pointer_id` tem ON DELETE CASCADE (migration 0054).
beforeEach(async () => {
  await pool.query(`delete from followup_flow_pointers where trigger_config->>'kind' = 'silence'`);
});

// ---- pg-backed SilenceSweepDb (test-only; prod usa createSupabaseSilenceSweepDb) ----

function silenceSweepDb(): SilenceSweepDb {
  return {
    async loadActiveSilencePointers(): Promise<SilencePointer[]> {
      const { rows } = await pool.query<{
        id: string;
        organization_id: string;
        active_version_id: string | null;
        trigger_config: { kind: string; params?: { threshold_minutes: number; segments?: string[] } };
      }>(
        `select id, organization_id, active_version_id, trigger_config
         from followup_flow_pointers
         where status = 'active' and active_version_id is not null`,
      );
      const pointers: SilencePointer[] = [];
      for (const row of rows) {
        if (row.trigger_config.kind !== "silence" || !row.active_version_id) continue;
        pointers.push({
          id: row.id,
          organization_id: row.organization_id,
          active_version_id: row.active_version_id,
          threshold_minutes: row.trigger_config.params!.threshold_minutes,
          segments: row.trigger_config.params!.segments ?? [],
        });
      }
      return pointers;
    },
    async loadSilentContactIds(orgId, cutoffIso, segments) {
      const { rows } = await pool.query<{ contact_id: string; last_inbound_at: string; tags: string[]; is_blocked: boolean }>(
        `select conv.contact_id, max(conv.last_inbound_at) as last_inbound_at,
                c.tags as tags, c.is_blocked as is_blocked
         from conversations conv
         join contacts c on c.id = conv.contact_id
         where conv.organization_id = $1 and conv.last_inbound_at is not null
         group by conv.contact_id, c.tags, c.is_blocked`,
        [orgId],
      );
      const cutoff = new Date(cutoffIso).getTime();
      return rows
        .filter((r) => !r.is_blocked)
        .filter((r) => new Date(r.last_inbound_at).getTime() <= cutoff)
        .filter((r) => segments.length === 0 || segments.some((s) => r.tags.includes(s)))
        .map((r) => r.contact_id);
    },
    async loadTriggerNodeId(orgId, versionId) {
      const { rows } = await pool.query<{ graph: FlowGraph }>(
        `select graph from followup_flow_versions where organization_id = $1 and id = $2`,
        [orgId, versionId],
      );
      if (rows.length === 0) return null;
      return rows[0]!.graph.nodes.find((n) => n.type === "trigger")?.id ?? null;
    },
    async insertEnrollment(input) {
      try {
        await pool.query(
          `insert into followup_enrollments
             (organization_id, pointer_id, version_id, contact_id, current_node_id, status, next_eval_at)
           values ($1, $2, $3, $4, $5, 'active', $6)`,
          [input.organization_id, input.pointer_id, input.version_id, input.contact_id, input.current_node_id, input.next_eval_at],
        );
        return { inserted: true };
      } catch (err) {
        if ((err as { code?: string }).code === "23505") return { inserted: false };
        throw err;
      }
    },
  };
}

// ---- pg-backed FollowupGateDb (mirrors createSupabaseFollowupGateDb's query, against real ai_agent_versions) ----

function pgGateDb(): FollowupGateDb {
  return {
    async loadEnabledPublishedFollowupPointerIds(orgId) {
      const { rows } = await pool.query<{ followup: unknown }>(
        `select followup from ai_agent_versions where organization_id = $1 and status = 'published'`,
        [orgId],
      );
      const ids = new Set<string>();
      for (const row of rows) {
        const f = row.followup as { enabled?: unknown; flow_pointer_ids?: unknown } | null;
        if (!f || f.enabled !== true || !Array.isArray(f.flow_pointer_ids)) continue;
        for (const id of f.flow_pointer_ids) if (typeof id === "string") ids.add(id);
      }
      return [...ids];
    },
  };
}

// ---- seed helpers ----

let orgSeq = 0;
function nextOrgId(): string {
  orgSeq += 1;
  return `dddddd${String(orgSeq).padStart(2, "0")}-0000-4000-8000-000000000001`;
}

async function seedOrg(org: string): Promise<void> {
  const name = `followup-silence-${org.slice(0, 8)}`;
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1, $2, $3, $4) on conflict (id) do nothing`,
    [org, name, name, name],
  );
}

async function seedContact(org: string, opts?: { tags?: string[]; isBlocked?: boolean }): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, display_name, tags, is_blocked) values ($1, 'Silence Contact', $2, $3) returning id`,
    [org, opts?.tags ?? [], opts?.isBlocked ?? false],
  );
  return rows[0]!.id;
}

async function seedChannelSession(org: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into channel_sessions (organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1, $2, 'WORKING', '\\x00'::bytea) returning id`,
    [org, `silence-session-${Date.now()}-${Math.random()}`],
  );
  return rows[0]!.id;
}

/** `agoMinutes=null` → conversa sem last_inbound_at (nunca recebeu inbound). */
async function seedConversation(org: string, contactId: string, agoMinutes: number | null): Promise<string> {
  const sessionId = await seedChannelSession(org);
  const lastInboundExpr = agoMinutes === null ? "null" : `now() - interval '${agoMinutes} minutes'`;
  const { rows } = await pool.query<{ id: string }>(
    `insert into conversations (organization_id, contact_id, channel_session_id, status, is_group, last_inbound_at)
     values ($1, $2, $3, 'open', false, ${lastInboundExpr}) returning id`,
    [org, contactId, sessionId],
  );
  return rows[0]!.id;
}

async function seedSilenceFlow(
  org: string,
  opts?: { thresholdMinutes?: number; segments?: string[] },
): Promise<{ pointerId: string; versionId: string }> {
  const graph: FlowGraph = {
    nodes: [
      { id: "t1", type: "trigger", label: "Start", position: { x: 0, y: 0 }, config: {} },
      { id: "e1", type: "end", label: "Done", position: { x: 0, y: 0 }, config: { outcome: "converted" } },
    ],
    edges: [{ id: "t1-e1", source: "t1", target: "e1", priority: 0, condition: { type: "always" } }],
  };
  const { rows: versionRows } = await pool.query<{ id: string }>(
    `insert into followup_flow_versions (organization_id, graph) values ($1, $2) returning id`,
    [org, JSON.stringify(graph)],
  );
  const versionId = versionRows[0]!.id;
  const triggerConfig = {
    kind: "silence",
    params: { threshold_minutes: opts?.thresholdMinutes ?? 60, segments: opts?.segments ?? [] },
  };
  const { rows: pointerRows } = await pool.query<{ id: string }>(
    `insert into followup_flow_pointers (organization_id, name, status, active_version_id, trigger_config)
     values ($1, $2, 'active', $3, $4) returning id`,
    [org, `Silence Flow ${Date.now()}-${Math.random()}`, versionId, JSON.stringify(triggerConfig)],
  );
  return { pointerId: pointerRows[0]!.id, versionId };
}

async function seedPublishedAgentVersion(
  org: string,
  opts: { status?: string; enabled?: boolean; pointerIds?: string[] },
): Promise<void> {
  const sessionId = await seedChannelSession(org);
  const { rows: agentRows } = await pool.query<{ id: string }>(
    `insert into ai_agents (organization_id, name, system_prompt) values ($1, $2, 'prompt') returning id`,
    [org, `Silence Gate Agent ${Date.now()}-${Math.random()}`],
  );
  const agentId = agentRows[0]!.id;
  const followup = { enabled: opts.enabled ?? true, flow_pointer_ids: opts.pointerIds ?? [] };
  await pool.query(
    `insert into ai_agent_versions
       (organization_id, agent_id, version_number, system_prompt, provider, model, channel_session_id, status, followup)
     values ($1, $2, 1, 'prompt', 'anthropic', 'claude-sonnet-4-6', $3, $4, $5)`,
    [org, agentId, sessionId, opts.status ?? "published", JSON.stringify(followup)],
  );
}

async function countEnrollments(pointerId: string, contactId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `select count(*) as n from followup_enrollments where pointer_id = $1 and contact_id = $2`,
    [pointerId, contactId],
  );
  return Number(rows[0]!.n);
}

const CLOCK = () => new Date();

// ---- 1. sweep enrolla + idempotência ------------------------------------

describe("runSilenceSweep — enrolla contato silencioso gateado, sem duplicar", () => {
  it("pointer silence habilitado + contato silêncio > threshold → 1 enrollment; 2ª varredura não duplica", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const { pointerId, versionId } = await seedSilenceFlow(org, { thresholdMinutes: 30 });
    await seedPublishedAgentVersion(org, { enabled: true, pointerIds: [pointerId] });
    const contactId = await seedContact(org);
    await seedConversation(org, contactId, 90); // silencioso há 90min > threshold 30min

    const deps = { db: silenceSweepDb(), gateDb: pgGateDb(), clock: CLOCK };

    const summary1 = await runSilenceSweep(deps);
    expect(summary1.pointers_scanned).toBeGreaterThanOrEqual(1);
    expect(summary1.enrolled).toBe(1);
    expect(summary1.skipped_existing).toBe(0);

    const enrollment = await pool.query<{ current_node_id: string; status: string }>(
      `select current_node_id, status from followup_enrollments where pointer_id = $1 and contact_id = $2`,
      [pointerId, contactId],
    );
    expect(enrollment.rows).toHaveLength(1);
    expect(enrollment.rows[0]!.current_node_id).toBe("t1");
    expect(enrollment.rows[0]!.status).toBe("active");

    // 2ª varredura: unique-live index barra duplicata — vira skipped_existing, não erro.
    const summary2 = await runSilenceSweep(deps);
    expect(summary2.enrolled).toBe(0);
    expect(summary2.skipped_existing).toBeGreaterThanOrEqual(1);
    expect(await countEnrollments(pointerId, contactId)).toBe(1);

    expect(versionId).toBeTruthy(); // sanity — version foi realmente usada (current_node_id veio do grafo pinado nela)
  });
});

// ---- 2. gate-out: sem agente publicado habilitando → 0 enrollments -----

describe("runSilenceSweep — gate-out (nenhum agente publicado habilita o pointer)", () => {
  it("mesmo contato silencioso, SEM agente publicado com followup.enabled → 0 enrollments (prova que o gate é chamado)", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const { pointerId } = await seedSilenceFlow(org, { thresholdMinutes: 30 });
    // nenhum ai_agent_versions publicado nesta org habilitando o pointer
    const contactId = await seedContact(org);
    await seedConversation(org, contactId, 90);

    const summary = await runSilenceSweep({ db: silenceSweepDb(), gateDb: pgGateDb(), clock: CLOCK });
    expect(summary.pointers_gated_out).toBeGreaterThanOrEqual(1);
    expect(await countEnrollments(pointerId, contactId)).toBe(0);
  });

  it("agente existe mas com followup.enabled=false → gate-out também", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const { pointerId } = await seedSilenceFlow(org, { thresholdMinutes: 30 });
    await seedPublishedAgentVersion(org, { enabled: false, pointerIds: [pointerId] });
    const contactId = await seedContact(org);
    await seedConversation(org, contactId, 90);

    const summary = await runSilenceSweep({ db: silenceSweepDb(), gateDb: pgGateDb(), clock: CLOCK });
    expect(summary.pointers_gated_out).toBeGreaterThanOrEqual(1);
    expect(await countEnrollments(pointerId, contactId)).toBe(0);
  });
});

// ---- 3. boundary: silêncio < threshold não enrolla ----------------------

describe("runSilenceSweep — boundary de threshold", () => {
  it("contato silencioso há MENOS que threshold_minutes → não enrolla", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const { pointerId } = await seedSilenceFlow(org, { thresholdMinutes: 60 });
    await seedPublishedAgentVersion(org, { enabled: true, pointerIds: [pointerId] });
    const contactId = await seedContact(org);
    await seedConversation(org, contactId, 10); // só 10min de silêncio, threshold=60

    const summary = await runSilenceSweep({ db: silenceSweepDb(), gateDb: pgGateDb(), clock: CLOCK });
    expect(summary.pointers_gated_out).toBe(0); // o gate passou — não é isso que bloqueou
    expect(summary.enrolled).toBe(0);
    expect(await countEnrollments(pointerId, contactId)).toBe(0);
  });
});

// ---- 4. gate SQL integration (contra ai_agent_versions REAL) ------------

describe("isPointerEnabledForAutomaticTrigger — integração SQL real (ai_agent_versions)", () => {
  it("publicado + enabled=true + pointer no array → true", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const { pointerId } = await seedSilenceFlow(org);
    await seedPublishedAgentVersion(org, { status: "published", enabled: true, pointerIds: [pointerId] });

    await expect(isPointerEnabledForAutomaticTrigger(pgGateDb(), org, pointerId)).resolves.toBe(true);
  });

  it("versão em rascunho (status='draft', não publicada) → false mesmo com enabled=true", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const { pointerId } = await seedSilenceFlow(org);
    await seedPublishedAgentVersion(org, { status: "draft", enabled: true, pointerIds: [pointerId] });

    await expect(isPointerEnabledForAutomaticTrigger(pgGateDb(), org, pointerId)).resolves.toBe(false);
  });

  it("publicado mas followup.enabled=false → false", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const { pointerId } = await seedSilenceFlow(org);
    await seedPublishedAgentVersion(org, { status: "published", enabled: false, pointerIds: [pointerId] });

    await expect(isPointerEnabledForAutomaticTrigger(pgGateDb(), org, pointerId)).resolves.toBe(false);
  });

  it("pointer habilitado numa org NÃO vaza pra outra org (cross-org)", async () => {
    const orgA = nextOrgId();
    const orgB = nextOrgId();
    await seedOrg(orgA);
    await seedOrg(orgB);
    const { pointerId } = await seedSilenceFlow(orgA);
    await seedPublishedAgentVersion(orgA, { status: "published", enabled: true, pointerIds: [pointerId] });

    await expect(isPointerEnabledForAutomaticTrigger(pgGateDb(), orgB, pointerId)).resolves.toBe(false);
  });
});
