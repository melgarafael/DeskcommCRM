/**
 * #2729 — a resposta em GRUPO entra na conta de saúde do número.
 *
 * O circuito (`lib/agent-engine/health/circuit.ts`) pausa o outbound de um
 * número antes de ele queimar: block rate e response rate na janela móvel. Ele
 * atribuía `send_ledger` ao número por `conversations` — mas só `is_group =
 * false`. Com a chave do grupo ligada, a IA envia por uma conversa de GRUPO da
 * MESMA sessão, e esses envios ficavam fora das QUATRO contagens: o número podia
 * estar bloqueando em grupo e o circuito não pausava nada antes do banimento.
 *
 * A régua é o SQL, então o caso roda contra o Postgres de verdade. A fixture tem
 * os dois lados e um terceiro que NÃO pode contar:
 *
 *   · contato 1:1 do número — 2 envios (1 aceito, 1 vetado), respondeu;
 *   · contato do GRUPO, mesma sessão — 2 envios (1 aceito, 1 vetado), respondeu;
 *   · contato SEM conversa nesta sessão — 1 envio aceito: não é deste número.
 *
 * Com o grupo fora da conta o esperado cai para 2/1/1/1, e é isso que fica
 * vermelho se alguém devolver `is_group = false` às contagens.
 */
import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { computeSessionRates } from "@/lib/agent-engine/health/circuit";

import { seedGov, GOV_ORG, GOV_SESSION } from "./gov-helpers";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 3,
});

const JANELA_MS = 60 * 60 * 1000;

async function contato(nome: string): Promise<string> {
  const id = randomUUID();
  await pool.query("insert into contacts(id,organization_id,display_name) values($1,$2,$3)", [
    id,
    GOV_ORG,
    nome,
  ]);
  return id;
}

async function conversa(contactId: string, grupo: boolean): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `insert into conversations(id,organization_id,contact_id,channel_session_id,channel,status,is_group,group_chat_id)
     values($1,$2,$3,$4,'whatsapp','open',$5,$6)`,
    [id, GOV_ORG, contactId, GOV_SESSION, grupo, grupo ? `${id}@g.us` : null],
  );
  return id;
}

/** Uma linha do `send_ledger` — a tentativa de envio que o circuito conta. */
async function envio(contactId: string, status: "accepted" | "vetoed"): Promise<void> {
  const jobId = randomUUID();
  await pool.query(
    `insert into job_queue (id, organization_id, contact_id, kind, payload, status, attempts)
     values ($1,$2,$3,'inbound_turn','{}','done',1)`,
    [jobId, GOV_ORG, contactId],
  );
  await pool.query(
    `insert into send_ledger (organization_id, contact_id, job_id, seq, body_hash, status)
     values ($1,$2,$3,1,'hash',$4)`,
    [GOV_ORG, contactId, jobId, status],
  );
}

/** O inbound do CRM: o evento que o drain emite para o turno do contato. */
async function inbound(contactId: string): Promise<void> {
  await pool.query(
    `insert into event_log (organization_id, event_type, entity_kind, entity_id, payload)
     values ($1,'ai_agent.dispatch_requested','message',$2,$3)`,
    [
      GOV_ORG,
      randomUUID(),
      { channel_session_id: GOV_SESSION, contact_id: contactId },
    ],
  );
}

beforeAll(async () => {
  await seedGov();
  const umParaUm = await contato("Contato 1:1");
  const doGrupo = await contato("Contato do grupo");
  const deOutroNumero = await contato("Contato de outro número");
  await conversa(umParaUm, false);
  await conversa(doGrupo, true);
  // `deOutroNumero` não tem conversa nesta sessão: os envios dele não são deste
  // número e não podem entrar na conta.
  for (const [ct, status] of [
    [umParaUm, "accepted"],
    [umParaUm, "vetoed"],
    [doGrupo, "accepted"],
    [doGrupo, "vetoed"],
    [deOutroNumero, "accepted"],
  ] as const) {
    await envio(ct, status);
  }
  await inbound(umParaUm);
  await inbound(doGrupo);
});

afterAll(async () => {
  await pool.end();
});

it("#2729 — as quatro contagens incluem os envios de grupo da MESMA sessão", async () => {
  const taxas = await computeSessionRates(pool, GOV_ORG, GOV_SESSION, JANELA_MS);
  expect(taxas).toEqual({
    totalSends: 4, // 2 do 1:1 + 2 do grupo
    blockedSends: 2, // 1 vetado de cada
    sentLeads: 2, // os dois contatos contatados
    respondedLeads: 2, // os dois responderam
  });
});
