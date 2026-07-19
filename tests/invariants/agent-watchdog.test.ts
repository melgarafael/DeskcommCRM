import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import {
  reconcileSessions,
  redriveQueued,
  type WatchdogConfig,
} from "@/lib/agent-engine/edge/crm/session-reconciler";
import { createLogger } from "@/lib/agent-engine/obs/logger";

/**
 * Fase 4A-2 — watchdog de sessão (o incidente real do Carlos, congelado em teste).
 *
 * Fixture: WAHA-mock local diz WORKING; o espelho channel_sessions diz STARTING;
 * uma resposta AI está presa em `queued`. O watchdog deve (1) reconciliar o
 * espelho e (2) reenviar a mensagem — que sai `sent` COM external_id extraído
 * do shape NOWEB. Regressão aqui = lead no vácuo de novo.
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

const ORG = "bbbbbbbb-0000-4000-8000-000000000001";
const CONTACT = "bbbbbbbb-0000-4000-8000-000000000002";
const SESSION = "bbbbbbbb-0000-4000-8000-000000000003";
const CONV = "bbbbbbbb-0000-4000-8000-000000000004";
const QUEUED_MSG = "bbbbbbbb-0000-4000-8000-000000000005";
const WAHA_SESSION_NAME = "watchdog-proof-session";
const NOWEB_ID = "3EB0WATCHDOGPROOF";

let wahaMock: http.Server;
let wahaPort = 0;
const sendTextCalls: Array<{ session: string; chatId: string; text: string }> = [];

function watchdogCfg(): WatchdogConfig {
  return {
    wahaBaseUrl: `http://127.0.0.1:${wahaPort}`,
    wahaApiKey: "test-key",
    intervalMs: 1000,
    redriveMinAgeMs: 0,
    redriveBatchSize: 10,
    redriveSpacingMs: 1,
  };
}

beforeAll(async () => {
  // WAHA-mock: /api/sessions responde WORKING; /api/sendText devolve o shape
  // NOWEB aninhado (o que quebrava o parse antigo).
  wahaMock = http.createServer((req, res) => {
    if (req.method === "GET" && req.url?.startsWith("/api/sessions")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([{ name: WAHA_SESSION_NAME, status: "WORKING" }]));
      return;
    }
    if (req.method === "POST" && req.url === "/api/sendText") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        sendTextCalls.push(JSON.parse(body) as (typeof sendTextCalls)[number]);
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: { id: NOWEB_ID }, timestamp: 1 }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => wahaMock.listen(0, "127.0.0.1", resolve));
  const addr = wahaMock.address();
  wahaPort = typeof addr === "object" && addr !== null ? addr.port : 0;

  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'wd-proof', 'Watchdog Proof', 'Watchdog Proof') on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1, $2, 'Carlos Prova', '+5511900000002') on conflict (id) do nothing`,
    [CONTACT, ORG],
  );
  // A DIVERGÊNCIA do incidente real: espelho STARTING, WAHA (mock) WORKING.
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1, $2, $3, 'STARTING', '\\x00'::bytea) on conflict (id) do nothing`,
    [SESSION, ORG, WAHA_SESSION_NAME],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
     values ($1, $2, $3, $4, 'open', false) on conflict (id) do nothing`,
    [CONV, ORG, CONTACT, SESSION],
  );
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
                           type, direction, status, body, sent_via, sent_at, metadata)
     values ($1, $2, $3, $4, $5, 'text', 'outbound', 'queued', 'resposta presa do agente', 'ai', now(),
             '{"queued_reason":"channel_session_not_working"}')
     on conflict (id) do nothing`,
    [QUEUED_MSG, ORG, CONV, SESSION, CONTACT],
  );
  // redriveQueued varre TODAS as orgs (comportamento de produção). No container
  // efêmero COMPARTILHADO com as outras suítes (ex.: automation-send-whatsapp
  // deixa uma outbound 'ai' queued), o cenário "exatamente 1 preso" precisa
  // garantir que a fila contém só a mensagem DESTE teste — sem isso o redrive
  // conta as mensagens vazadas das vizinhas.
  await pool.query(
    `delete from messages where status = 'queued' and sent_via = 'ai' and organization_id <> $1`,
    [ORG],
  );
});

afterAll(async () => {
  await new Promise<void>((resolve) => wahaMock.close(() => resolve()));
  await pool.end();
});

describe("4A-2 — watchdog reconcilia o espelho e reenvia queued", () => {
  it("reconciliador: espelho STARTING vira WORKING (fonte = WAHA real)", async () => {
    const fixed = await reconcileSessions(pool, watchdogCfg(), log);
    expect(fixed).toBeGreaterThanOrEqual(1);

    const { rows } = await pool.query(
      "select status from channel_sessions where id = $1",
      [SESSION],
    );
    expect(rows[0]!.status).toBe("WORKING");
  });

  it("redrive: a queued sai sent COM external_id (shape NOWEB parseado)", async () => {
    const redriven = await redriveQueued(pool, watchdogCfg(), log);
    expect(redriven).toBe(1);

    // o WAHA recebeu exatamente 1 sendText, para a sessão certa
    expect(sendTextCalls).toHaveLength(1);
    expect(sendTextCalls[0]).toMatchObject({
      session: WAHA_SESSION_NAME,
      text: "resposta presa do agente",
    });

    const { rows } = await pool.query(
      "select status, external_id, metadata->>'redrive' as redrive from messages where id = $1",
      [QUEUED_MSG],
    );
    expect(rows[0]).toMatchObject({ status: "sent", external_id: NOWEB_ID, redrive: "watchdog" });
  });

  it("idempotência: segundo tick não reenvia (nada mais queued)", async () => {
    const redriven = await redriveQueued(pool, watchdogCfg(), log);
    expect(redriven).toBe(0);
    expect(sendTextCalls).toHaveLength(1); // nenhum sendText novo
  });
});
