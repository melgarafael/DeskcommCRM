/**
 * O `send_ledger` de verdade (Postgres) lê a natureza da recusa na linha da
 * mensagem — e não reenvia o mesmo corpo já recusado em definitivo.
 *
 * O teste unitário (`tests/unit/send-ledger-falha-permanente.test.ts`) prova a
 * regra com um dublê; este prova as consultas de `pgSendLedger`: o `select *`
 * que traz `body_hash` e o `metadata->'falha_de_envio'` que volta do banco.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { pgSendLedger, sendWithLedger } from "@/lib/agent-engine/edge/crm/send-ledger";
import { enqueueJob } from "@/lib/agent-engine/queue/queue";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 2,
});
afterAll(() => pool.end());

const ORG = randomUUID();
const CONTACT = randomUUID();
const SESSION = randomUUID();
const CONV = randomUUID();
let JOB = "";

beforeAll(async () => {
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Ledger','Ledger')",
    [ORG],
  );
  await pool.query("insert into contacts(id,organization_id,name,phone_number) values($1,$2,'Cliente','+5511900004701')", [
    CONTACT,
    ORG,
  ]);
  await pool.query(
    "insert into channel_sessions(id,organization_id,waha_session_name,status,webhook_secret_encrypted) values($1,$2,$3,'WORKING','\\x00'::bytea)",
    [SESSION, ORG, `ledger-${SESSION.slice(0, 8)}`],
  );
  await pool.query(
    "insert into conversations(id,organization_id,contact_id,channel_session_id,status,is_group) values($1,$2,$3,$4,'ai_handling',false)",
    [CONV, ORG, CONTACT, SESSION],
  );
  JOB = (
    await enqueueJob(pool, ORG, {
      kind: "inbound_turn",
      leadId: CONTACT,
      payload: { conversation_id: CONV, contact_id: CONTACT, channel_session_id: SESSION },
      maxAttempts: 1,
    })
  ).job.id;
});

/** O que o handler grava quando o adapter falha — a linha `failed` com a natureza. */
function canalQueRecusa(natureza: "permanente" | "transitoria") {
  return vi.fn(async (key: string, id: string) => {
    await pool.query(
      `insert into messages(id,organization_id,contact_id,conversation_id,channel_session_id,direction,type,status,body,metadata)
       values($1,$2,$3,$4,$5,'outbound','text','failed','corpo',$6)`,
      [id, ORG, CONTACT, CONV, SESSION, { idempotency_key: key, falha_de_envio: { natureza, status_http: 400 } }],
    );
    return { id, status: "failed", metadata: { falha_de_envio: { natureza } } };
  });
}

it("⭐ recusa definitiva: a volta da fila com o MESMO corpo não chama o canal de novo", async () => {
  const input = { tenantId: ORG, leadId: CONTACT, jobId: JOB, seq: 1, body: "Segue o áudio" };
  const send = canalQueRecusa("permanente");

  const primeira = await sendWithLedger(pgSendLedger(pool), input, send);
  expect(primeira).toMatchObject({ kind: "failed", permanente: true });

  const volta = await sendWithLedger(pgSendLedger(pool), input, send);
  expect(volta).toMatchObject({ kind: "failed", permanente: true, idempotencyKey: primeira.idempotencyKey });
  expect(send, "o canal recebeu de novo o conteúdo que já tinha recusado").toHaveBeenCalledOnce();

  const { rows } = await pool.query("select count(*)::int n from messages where organization_id=$1 and status='failed' and contact_id=$2 and body='corpo'", [ORG, CONTACT]);
  expect(rows[0].n, "um balão vermelho só").toBe(1);
});

it("falha transitória: a volta rotaciona e tenta de novo (o de sempre)", async () => {
  const input = { tenantId: ORG, leadId: CONTACT, jobId: JOB, seq: 2, body: "Outra resposta" };
  const send = canalQueRecusa("transitoria");

  const primeira = await sendWithLedger(pgSendLedger(pool), input, send);
  expect(primeira).toMatchObject({ kind: "failed", permanente: false });
  const volta = await sendWithLedger(pgSendLedger(pool), input, send);
  expect(volta).toMatchObject({ kind: "failed", permanente: false });
  expect(volta.idempotencyKey).not.toBe(primeira.idempotencyKey);
  expect(send).toHaveBeenCalledTimes(2);
});
