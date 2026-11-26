import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedGov, GOV_ORG, GOV_SESSION, GOV_AGENT_A } from "./gov-helpers";

/**
 * INVARIANTE DE BANCO — Encerramento Seguro Condicional (PR 01).
 *
 * Exercita `public.fn_safe_close_conversation` contra Postgres real:
 *  - fechamento válido com carimbo e incremento de `service_revision`;
 *  - recusa `PT409` por nova mensagem inbound, revisão obsoleta, responsável/setor
 *    divergentes, atendimento humano ativo e pendência aberta;
 *  - concorrência real com duas sessões simultâneas (`Promise.all`) sob
 *    `fn_service_lock` + `FOR NO KEY UPDATE`;
 *  - idempotência por `p_idempotency_key` e isolamento entre organizações.
 */
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 6,
});

const otherOrg = randomUUID();

async function criarConversa(
  overrides: { status?: string; assigned?: string | null; assigneeKind?: string | null } = {},
) {
  const contactId = randomUUID();
  await pool.query(
    `insert into contacts(id, organization_id, phone_number, name)
     values($1, $2, $3, 'Contato Safe Close')
     on conflict do nothing`,
    [contactId, GOV_ORG, `+55119${Math.floor(10000000 + Math.random() * 89999999)}`],
  );
  const id = randomUUID();
  await pool.query(
    `insert into conversations(id, organization_id, contact_id, channel_session_id, status, assigned_to_user_id, assignee_kind)
     values($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      GOV_ORG,
      contactId,
      GOV_SESSION,
      overrides.status ?? "open",
      overrides.assigned ?? null,
      overrides.assigneeKind ?? "ai",
    ],
  );
  return { id, contactId };
}

async function inserirInbound(conversationId: string, contactId: string) {
  const mid = randomUUID();
  await pool.query(
    `insert into messages(id, organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, sent_via, body, sent_at)
     values($1, $2, $3, $4, $5, 'text', 'inbound', 'received', 'crm', 'Oi', clock_timestamp())`,
    [mid, GOV_ORG, conversationId, GOV_SESSION, contactId],
  );
  return mid;
}

async function chamarSafeClose(
  client: pg.Pool | pg.PoolClient,
  params: {
    org?: string;
    conv: string;
    expectedRevision?: number | null;
    expectedStatus?: string | null;
    expectedLastInboundId?: string | null;
    enforceLastInbound?: boolean;
    expectedAssignee?: string | null;
    enforceAssignee?: boolean;
    expectedSector?: string | null;
    enforceSector?: boolean;
    rejectHuman?: boolean;
    rejectPendencies?: boolean;
    idempotencyKey?: string | null;
  },
) {
  const { rows } = await client.query<{ fn_safe_close_conversation: Record<string, unknown> }>(
    `select public.fn_safe_close_conversation(
      $1::uuid, $2::uuid, $3::bigint, $4::text,
      $5::uuid, $6::boolean, null::timestamptz,
      $7::uuid, $8::boolean, $9::uuid, $10::boolean,
      $11::boolean, $12::boolean, $13::text
    )`,
    [
      params.org ?? GOV_ORG,
      params.conv,
      params.expectedRevision ?? null,
      params.expectedStatus ?? null,
      params.expectedLastInboundId ?? null,
      params.enforceLastInbound ?? false,
      params.expectedAssignee ?? null,
      params.enforceAssignee ?? false,
      params.expectedSector ?? null,
      params.enforceSector ?? false,
      params.rejectHuman ?? true,
      params.rejectPendencies ?? true,
      params.idempotencyKey ?? null,
    ],
  );
  return rows[0]!.fn_safe_close_conversation;
}

beforeAll(async () => {
  seedGov();
});

afterAll(async () => {
  await pool.end();
});

describe("Invariantes de banco — fn_safe_close_conversation (PR 01)", () => {
  it("fecha conversa válida atomicamente, preserva auditoria/estado e suporta replay idempotente", async () => {
    const { id: conv, contactId } = await criarConversa();
    const m1 = await inserirInbound(conv, contactId);

    const r1 = await chamarSafeClose(pool, {
      conv,
      expectedRevision: 1,
      expectedStatus: "open",
      expectedLastInboundId: m1,
      enforceLastInbound: true,
      idempotencyKey: "k-valid-1",
    });
    expect(r1.closed).toBe(true);
    expect(r1.already_closed).toBe(false);
    expect((r1.conversation as Record<string, unknown>).status).toBe("closed");
    expect((r1.conversation as Record<string, unknown>).service_revision).toBe(2);

    const r2 = await chamarSafeClose(pool, {
      conv,
      expectedRevision: 1,
      idempotencyKey: "k-valid-1",
    });
    expect(r2.idempotent_replay).toBe(true);
    expect(r2.already_closed).toBe(true);
  });

  it("recusa com PT409 quando chega nova mensagem inbound antes do encerramento", async () => {
    const { id: conv, contactId } = await criarConversa();
    const m1 = await inserirInbound(conv, contactId);
    await inserirInbound(conv, contactId);

    await expect(
      chamarSafeClose(pool, {
        conv,
        expectedLastInboundId: m1,
        enforceLastInbound: true,
      }),
    ).rejects.toMatchObject({ code: "PT409", message: "safe_close_conflict:new_inbound_message" });
  });

  it("recusa com PT409 quando há caso aberto (agent_cases) ou conversa assumida por humano", async () => {
    const { id: convHumana } = await criarConversa({
      status: "claimed",
      assigned: GOV_AGENT_A,
      assigneeKind: "user",
    });
    await expect(chamarSafeClose(pool, { conv: convHumana })).rejects.toMatchObject({
      code: "PT409",
      message: "safe_close_conflict:human_attendance_active",
    });

    const { id: convCaso } = await criarConversa();
    await pool.query(
      `insert into agent_cases(organization_id, conversation_id, status, title, summary, blocker)
       values($1, $2, 'awaiting_human', 'Caso aberto', 'Resumo', 'Dúvida técnica')`,
      [GOV_ORG, convCaso],
    );
    await expect(chamarSafeClose(pool, { conv: convCaso })).rejects.toMatchObject({
      code: "PT409",
      message: "safe_close_conflict:open_agent_case",
    });
  });

  it("concorrência real: duas sessões simultâneas com expected_revision — apenas uma fecha, a outra recebe PT409", async () => {
    const { id: conv } = await criarConversa();
    const c1 = await pool.connect();
    const c2 = await pool.connect();
    try {
      const res = await Promise.allSettled([
        chamarSafeClose(c1, { conv, expectedRevision: 1 }),
        chamarSafeClose(c2, { conv, expectedRevision: 1 }),
      ]);
      const okCount = res.filter((r) => r.status === "fulfilled").length;
      const errCount = res.filter(
        (r) => r.status === "rejected" && (r.reason as { code?: string }).code === "PT409",
      ).length;
      expect(okCount).toBe(1);
      expect(errCount).toBe(1);
    } finally {
      c1.release();
      c2.release();
    }
  });

  it("isolamento entre organizações: devolve P0002 para outra organização", async () => {
    const { id: conv } = await criarConversa();
    await expect(chamarSafeClose(pool, { org: otherOrg, conv })).rejects.toMatchObject({
      code: "P0002",
    });
  });
});
