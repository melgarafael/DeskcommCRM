import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import {
  escalateCase,
  markAwaitingLead,
  openCase,
  provideCaseUpdate,
} from "@/lib/agent-engine/agent/human-cases";

/**
 * `provide_case_update` só alcança caso DA CONVERSA do turno.
 *
 * O `case_id` vem do modelo. Um caso de outra conversa (outro contato), na
 * MESMA org e aguardando o cliente, fica intacto: sem mudança de status e sem
 * evento `lead_provided`. Postgres real via `pnpm test:db`, como
 * `human-cases.test.ts`.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});

const ORG = "cdcdcdcd-0000-4000-8000-000000000001";
const SESSION = "cdcdcdcd-0000-4000-8000-000000000002";
const ACTOR = "cdcdcdcd-0000-4000-8000-000000000003";
const CONTATO_DO_TURNO = "cdcdcdcd-0000-4000-8000-000000000011";
const CONVERSA_DO_TURNO = "cdcdcdcd-0000-4000-8000-000000000012";
const CONTATO_DE_B = "cdcdcdcd-0000-4000-8000-000000000021";
const CONVERSA_DE_B = "cdcdcdcd-0000-4000-8000-000000000022";

async function conversa(id: string, contato: string, sufixo: string) {
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1, $2, 'Contato de Prova', $3) on conflict (id) do nothing`,
    [contato, ORG, `+5511700${sufixo}`],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
     values ($1, $2, $3, $4, 'ai_handling', false) on conflict (id) do nothing`,
    [id, ORG, contato, SESSION],
  );
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'caso-turno-prova', 'Org de Prova', 'Org de Prova') on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1, $2, 'caso-turno-prova', 'WORKING', '\\x00'::bytea) on conflict (id) do nothing`,
    [SESSION, ORG],
  );
  await pool.query(
    `insert into auth.users (id, email) values ($1, 'caso-turno@prova.test') on conflict (id) do nothing`,
    [ACTOR],
  );
  await conversa(CONVERSA_DO_TURNO, CONTATO_DO_TURNO, "000011");
  await conversa(CONVERSA_DE_B, CONTATO_DE_B, "000021");
});

afterAll(async () => {
  await pool.end();
});

describe("provideCaseUpdate — escopo da conversa do turno", () => {
  it("caso de outra conversa fica intacto; o da própria conversa passa", async () => {
    const aberto = await openCase(pool, { tenantId: ORG, conversationId: CONVERSA_DE_B }, {
      title: "Precisa do endereço",
      summary: "Falta o endereço de entrega.",
      blocker: "Sem endereço não despacha.",
    });
    if (!aberto.ok) throw new Error("setup falhou");
    await markAwaitingLead(pool, ORG, aberto.caseId, ACTOR, "Qual o endereço?");

    const alheio = await provideCaseUpdate(pool, { tenantId: ORG, conversationId: CONVERSA_DO_TURNO }, {
      caseId: aberto.caseId,
      info: "texto de outro cliente",
    });
    expect(alheio).toMatchObject({ ok: false, error: { code: "invalid_case_state" } });

    const status = await pool.query(`select status from agent_cases where id = $1`, [aberto.caseId]);
    expect(status.rows[0]).toMatchObject({ status: "awaiting_lead" });
    const eventos = await pool.query(
      `select 1 from agent_case_events where case_id = $1 and kind = 'lead_provided'`,
      [aberto.caseId],
    );
    expect(eventos.rows).toHaveLength(0);

    // controle: da própria conversa, passa
    const proprio = await provideCaseUpdate(pool, { tenantId: ORG, conversationId: CONVERSA_DE_B }, {
      caseId: aberto.caseId,
      info: "Rua das Flores, 10",
    });
    expect(proprio).toMatchObject({ ok: true });

    await escalateCase(pool, ORG, aberto.caseId, ACTOR, "limpeza do teste");
  });
});
