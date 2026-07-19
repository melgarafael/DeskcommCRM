import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { drainTick } from "@/lib/agent-engine/edge/crm/drain";
import { createLogger } from "@/lib/agent-engine/obs/logger";

/**
 * Fase 4A-1 — consumidor ÚNICO de ai_agent.dispatch_requested.
 *
 * Roda contra o Postgres efêmero do test-db.sh (baseline aplicado — inclui o
 * harness 0050) usando o CÓDIGO REAL do drain do engine. Congela:
 *   1. 1 evento → exatamente 1 job (nem zero, nem dois);
 *   2. re-drenar não duplica (evento done + dedup por source_event_id);
 *   3. o claim CAS do consumidor nativo (dispatchAgents) NÃO consegue pegar um
 *      evento que o engine já consumiu (status != pending) — mecanicamente.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:invariants` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});
const log = createLogger();

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const CONTACT = "aaaaaaaa-0000-4000-8000-000000000002";
const SESSION = "aaaaaaaa-0000-4000-8000-000000000003";
const CONV = "aaaaaaaa-0000-4000-8000-000000000004";
const MSG = "aaaaaaaa-0000-4000-8000-000000000005";

const DRAIN_KNOBS = {
  batchSize: 20,
  intervalMs: 100,
  idleIntervalMs: 100,
  debounceMs: 0, // sem debounce: o job nasce imediatamente drenável no teste
  reapTimeoutMs: 300_000,
};

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'disp-proof', 'Dispatch Proof', 'Dispatch Proof')
     on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1, $2, 'Lead Prova', '+5511900000001') on conflict (id) do nothing`,
    [CONTACT, ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1, $2, 'disp-proof-session', 'WORKING', '\\x00'::bytea) on conflict (id) do nothing`,
    [SESSION, ORG],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
     values ($1, $2, $3, $4, 'open', false) on conflict (id) do nothing`,
    [CONV, ORG, CONTACT, SESSION],
  );
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
                           type, direction, status, body, sent_via, sent_at)
     values ($1, $2, $3, $4, $5, 'text', 'inbound', 'delivered', 'oi', 'external_device', now())
     on conflict (id) do nothing`,
    [MSG, ORG, CONV, SESSION, CONTACT],
  );
});

afterAll(async () => {
  await pool.end();
});

async function insertDispatchEvent(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into event_log (organization_id, event_type, entity_kind, entity_id, payload, status)
     values ($1::uuid, 'ai_agent.dispatch_requested', 'message', $2::uuid,
             jsonb_build_object('organization_id', $1::text, 'conversation_id', $3::text,
                                'contact_id', $4::text, 'channel_session_id', $5::text,
                                'inbound_message_id', $2::text),
             'pending')
     returning id`,
    [ORG, MSG, CONV, CONTACT, SESSION],
  );
  return rows[0]!.id;
}

describe("4A-1 — dispatch_requested tem consumidor ÚNICO", () => {
  it("1 evento → o drain do engine gera EXATAMENTE 1 job", async () => {
    const eventId = await insertDispatchEvent();

    await drainTick(pool, DRAIN_KNOBS, log);

    const { rows: jobs } = await pool.query(
      "select id, kind, status from job_queue where source_event_id = $1",
      [eventId],
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ kind: "inbound_turn" });

    const { rows: ev } = await pool.query(
      "select status, consumed_by from event_log where id = $1",
      [eventId],
    );
    expect(ev[0]!.status).toBe("done");
    expect(ev[0]!.consumed_by).toContain("agent-engine");

    // re-drenar N vezes NÃO duplica: o evento saiu de 'pending'.
    await drainTick(pool, DRAIN_KNOBS, log);
    await drainTick(pool, DRAIN_KNOBS, log);
    const { rows: jobsAfter } = await pool.query(
      "select count(*)::int as n from job_queue where source_event_id = $1",
      [eventId],
    );
    expect(jobsAfter[0]!.n).toBe(1);
  });

  it("o claim CAS do consumidor NATIVO não pega evento já consumido pelo engine", async () => {
    const eventId = await insertDispatchEvent();
    await drainTick(pool, DRAIN_KNOBS, log); // engine consome

    // Réplica exata do claim do dispatchAgents (lib/ai/dispatcher/index.ts):
    // UPDATE ... WHERE id = $1 AND status = 'pending'. Consumido ⇒ 0 linhas.
    const { rowCount } = await pool.query(
      `update event_log set status = 'processing', updated_at = now()
       where id = $1 and status = 'pending'`,
      [eventId],
    );
    expect(rowCount).toBe(0);
  });

  it("dedup por unique: enqueue repetido do MESMO source_event_id não cria 2º job", async () => {
    const eventId = await insertDispatchEvent();
    await drainTick(pool, DRAIN_KNOBS, log);

    // corrida residual: outro processo tentando inserir job para o mesmo evento
    // esbarra na unique (organization_id, source_event_id).
    await expect(
      pool.query(
        `insert into job_queue (organization_id, contact_id, kind, source_event_id, payload)
         values ($1, $2, 'inbound_turn', $3, '{}')`,
        [ORG, CONTACT, eventId],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });
});
