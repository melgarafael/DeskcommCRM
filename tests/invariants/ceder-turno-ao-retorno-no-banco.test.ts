import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { deveCederTurnoAoRetorno } from "@/lib/followup/ceder-turno-ao-retorno";

/**
 * `deveCederTurnoAoRetorno` contra Postgres real — o SQL dos "vivos".
 *
 * A função roda no caminho quente de todo turno, e os unitários dela
 * (`lib/followup/ceder-turno-ao-retorno.test.ts`) usam um pool fingido que
 * devolve linhas prontas: o `left join messages` e a comparação
 * `e.started_at >= m.created_at` nunca chegaram a um Postgres. Um erro de
 * coluna, de join ou de tipo ali vira `false` calado pelo `catch` fail-open —
 * o agente volta a falar por cima do fluxo de retorno sem nenhum vermelho.
 *
 * Os quatro casos partem do MESMO cenário (ponteiro de retorno armado,
 * conversa sem humano, mensagem há 10 min) e mudam uma coisa só: quando a
 * inscrição nasceu, de qual ponteiro ela é, ou se o evento de inscrição já foi
 * gravado. Assim um `false` não pode vir de um retorno antecipado por cenário
 * incompleto — o caso 1, que dá `true`, é o controle dos outros.
 *
 * Cada caso tem a sua organização: o índice `idx_followup_enrollments_one_live`
 * é por (organização, contato) e a função lê todos os ponteiros da org.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 4,
});

afterAll(async () => {
  await pool.end();
});

// Grafo só de texto: o ramo do `nasceu_depois` vem antes do gate de agente, mas
// o ponteiro tem de ser um que o produtor de verdade armaria.
const GRAFO = {
  nodes: [
    { id: "t1", type: "trigger", label: "Início", position: { x: 0, y: 0 }, config: {} },
    { id: "e1", type: "end", label: "Fim", position: { x: 0, y: 0 }, config: { outcome: "converted" } },
  ],
  edges: [{ id: "t1-e1", source: "t1", target: "e1", priority: 0, condition: { type: "always" } }],
};

const RETORNO = { kind: "inbound_after_silence", params: { threshold_minutes: 60 } };
const MANUAL = { kind: "manual" };

interface Cenario {
  org: string;
  contactId: string;
  conversationId: string;
  messageId: string;
  pointerRetorno: string;
  versionId: string;
}

async function seedPointer(org: string, versionId: string, triggerConfig: unknown): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into followup_flow_pointers (organization_id, name, status, active_version_id, trigger_config)
     values ($1, $2, 'active', $3, $4) returning id`,
    [org, `ceder-${randomUUID()}`, versionId, JSON.stringify(triggerConfig)],
  );
  return rows[0]!.id;
}

/** Ponteiro de retorno armado + contato + conversa sem humano + inbound há 10 min. */
async function seedCenario(): Promise<Cenario> {
  const org = randomUUID();
  const nome = `ceder-turno-${org.slice(0, 8)}`;
  // `slug` é citext e os nomes são text: um único `$2` para os três dá
  // "inconsistent types deduced for parameter" — um parâmetro por coluna.
  await pool.query(`insert into organizations (id, slug, legal_name, display_name) values ($1, $2, $3, $4)`, [
    org,
    nome,
    nome,
    nome,
  ]);
  const { rows: ct } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, display_name) values ($1, 'Cliente que voltou') returning id`,
    [org],
  );
  const contactId = ct[0]!.id;
  const { rows: ss } = await pool.query<{ id: string }>(
    `insert into channel_sessions (organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1, $2, 'WORKING', '\\x00'::bytea) returning id`,
    [org, `ceder-${randomUUID()}`],
  );
  const sessionId = ss[0]!.id;
  const { rows: cv } = await pool.query<{ id: string }>(
    `insert into conversations (organization_id, contact_id, channel_session_id, status, is_group, last_inbound_at)
     values ($1, $2, $3, 'open', false, now() - interval '10 minutes') returning id`,
    [org, contactId, sessionId],
  );
  const conversationId = cv[0]!.id;
  const messageId = randomUUID();
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
                           type, direction, status, body, sent_via, sent_at, created_at)
     values ($1, $2, $3, $4, $5, 'text', 'inbound', 'received', 'voltei', 'external_device',
             now() - interval '10 minutes', now() - interval '10 minutes')`,
    [messageId, org, conversationId, sessionId, contactId],
  );
  const { rows: vs } = await pool.query<{ id: string }>(
    `insert into followup_flow_versions (organization_id, graph) values ($1, $2) returning id`,
    [org, JSON.stringify(GRAFO)],
  );
  const versionId = vs[0]!.id;
  const pointerRetorno = await seedPointer(org, versionId, RETORNO);
  return { org, contactId, conversationId, messageId, pointerRetorno, versionId };
}

/** `minutosAtras` controla `started_at`; a mensagem foi há 10 minutos. */
async function seedInscricao(c: Cenario, pointerId: string, minutosAtras: number): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into followup_enrollments
       (organization_id, pointer_id, version_id, contact_id, conversation_id, current_node_id, status,
        next_eval_at, started_at)
     values ($1, $2, $3, $4, $5, 't1', 'active', now(),
             now() - make_interval(mins => $6::int))
     returning id`,
    [c.org, pointerId, c.versionId, c.contactId, c.conversationId, minutosAtras],
  );
  return rows[0]!.id;
}

function ceder(c: Cenario): Promise<boolean> {
  return deveCederTurnoAoRetorno(pool, {
    organizationId: c.org,
    contactId: c.contactId,
    conversationId: c.conversationId,
    messageId: c.messageId,
  });
}

describe("deveCederTurnoAoRetorno — o SQL dos vivos contra Postgres real", () => {
  it("inscrição de retorno nascida DEPOIS da mensagem, ainda sem o evento de inscrição → cede", async () => {
    const c = await seedCenario();
    await seedInscricao(c, c.pointerRetorno, 5);
    expect(await ceder(c)).toBe(true);
  });

  it("inscrição de retorno nascida ANTES da mensagem → outro fluxo no slot, não cede", async () => {
    const c = await seedCenario();
    await seedInscricao(c, c.pointerRetorno, 20);
    expect(await ceder(c)).toBe(false);
  });

  it("inscrição viva de ponteiro que NÃO é de retorno, nascida depois → não cede", async () => {
    const c = await seedCenario();
    const manual = await seedPointer(c.org, c.versionId, MANUAL);
    await seedInscricao(c, manual, 5);
    expect(await ceder(c)).toBe(false);
  });

  it("evento de inscrição com o message_id desta mensagem → cede, mesmo com a inscrição mais velha", async () => {
    const c = await seedCenario();
    const enrollmentId = await seedInscricao(c, c.pointerRetorno, 20);
    await pool.query(
      `insert into followup_enrollment_events (organization_id, enrollment_id, node_id, event_type, payload)
       values ($1, $2, 't1', 'enrolled_by_inbound_after_silence', $3)`,
      [c.org, enrollmentId, JSON.stringify({ message_id: c.messageId })],
    );
    expect(await ceder(c)).toBe(true);
  });
});
