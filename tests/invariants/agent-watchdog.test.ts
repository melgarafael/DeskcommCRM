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
// O que o próximo `sendText` devolve, na ordem. Fila vazia = o shape NOWEB de
// sempre com `NOWEB_ID` — é o que os casos originais desta suíte esperam, e eles
// não precisam saber que a fila existe.
const proximasRespostasDoSendText: unknown[] = [];
const startCalls: string[] = [];
const wahaStatusByName: Record<string, string> = { [WAHA_SESSION_NAME]: "WORKING" };
const STOPPED_SESSION = "bbbbbbbb-0000-4000-8000-000000000006";
const STOPPED_NAME = "watchdog-stopped-session";

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
  // WAHA-mock: /api/sessions espelha wahaStatusByName; POST /start marca STARTING;
  // /api/sendText devolve o shape NOWEB aninhado (o que quebrava o parse antigo).
  wahaMock = http.createServer((req, res) => {
    const start = req.method === "POST" ? req.url?.match(/^\/api\/sessions\/([^/]+)\/start/) : null;
    if (start) {
      const name = decodeURIComponent(start[1] ?? "");
      startCalls.push(name);
      wahaStatusByName[name] = "STARTING";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "STARTING" }));
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/api/sessions")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          Object.entries(wahaStatusByName).map(([name, status]) => ({ name, status })),
        ),
      );
      return;
    }
    if (req.method === "POST" && req.url === "/api/sendText") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        sendTextCalls.push(JSON.parse(body) as (typeof sendTextCalls)[number]);
        res.writeHead(201, { "content-type": "application/json" });
        res.end(
          JSON.stringify(proximasRespostasDoSendText.shift() ?? { id: { id: NOWEB_ID }, timestamp: 1 }),
        );
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

  it("retoma sessão STOPPED — credencial no disco, sem pedir QR", async () => {
    wahaStatusByName[STOPPED_NAME] = "STOPPED";
    await pool.query(
      `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
       values ($1, $2, $3, 'STOPPED', '\\x00'::bytea) on conflict (id) do nothing`,
      [STOPPED_SESSION, ORG, STOPPED_NAME],
    );
    startCalls.length = 0;

    const fixed = await reconcileSessions(pool, watchdogCfg(), log);
    expect(fixed).toBeGreaterThanOrEqual(1);
    expect(startCalls).toEqual([STOPPED_NAME]);

    const { rows } = await pool.query("select status from channel_sessions where id = $1", [
      STOPPED_SESSION,
    ]);
    expect(rows[0]!.status).toBe("STARTING");
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

  it("pré-go-live: testador recebe o reenvio, mas removê-lo barra a próxima queued", async () => {
    await pool.query(
      `update channel_sessions set metadata = '{"ai_gate":"allowlist","ai_gate_mode":"pre_go_live","ai_test_phone_numbers":["+5511900000002"]}'
       where id = $1 and organization_id = $2`,
      [SESSION, ORG],
    );
    await pool.query("update messages set status = 'queued', external_id = null where id = $1", [QUEUED_MSG]);
    sendTextCalls.length = 0;
    expect(await redriveQueued(pool, watchdogCfg(), log)).toBe(1);
    expect(sendTextCalls).toHaveLength(1);

    // A mensagem já existia quando o operador retirou o número da lista.
    await pool.query("update messages set status = 'queued', external_id = null where id = $1", [QUEUED_MSG]);
    await pool.query(
      `update channel_sessions set metadata = jsonb_set(metadata, '{ai_test_phone_numbers}', '[]')
       where id = $1 and organization_id = $2`,
      [SESSION, ORG],
    );
    sendTextCalls.length = 0;
    expect(await redriveQueued(pool, watchdogCfg(), log)).toBe(0);
    expect(sendTextCalls).toHaveLength(0);
    const { rows } = await pool.query("select status, error_code from messages where id = $1", [QUEUED_MSG]);
    expect(rows[0]).toMatchObject({ status: "failed", error_code: "pre_go_live" });

    // Abrir ao público não ressuscita uma resposta velha já bloqueada.
    await pool.query(
      `update channel_sessions set metadata = jsonb_set(metadata, '{ai_gate}', '"open"') where id = $1`,
      [SESSION],
    );
    expect(await redriveQueued(pool, watchdogCfg(), log)).toBe(0);
    expect(sendTextCalls).toHaveLength(0);
  });
});

/**
 * O ECO DO PRÓPRIO REENVIO — a mensagem duplicada que "voltava".
 *
 * O envio normal (`app/api/v1/messages/_handler.ts`) apaga, logo depois que o
 * canal devolve o id, a linha que o webhook criou para o eco da mensagem que ele
 * acabou de mandar (`removerEcoDoProprioEnvio`). O reenvio do watchdog não fazia
 * isso — e é justamente o caminho das mensagens que ficaram presas numa
 * reconexão do WhatsApp. O eco chegava pelo webhook antes de o reenvio gravar o
 * id, não casava com nada e virava uma segunda linha com a mesma frase, que
 * ninguém apagava. Por depender de uma corrida, sumia e voltava.
 *
 * As linhas "do celular" abaixo simulam o que o webhook de fato grava: o
 * `handleOutboundFromUserPhone` é check-then-act, e com a linha do envio ainda
 * sem id o SELECT dele não acha nada e o INSERT passa.
 *
 * As formas do id são as de cada engine:
 *   NOWEB — o sendText devolve o id cru; o eco chega composto `true_<chat>_<id>`
 *   WEBJS — os dois lados usam o `_serialized` completo, a MESMA string
 */
describe("o reenvio não deixa o eco da própria mensagem duplicado", () => {
  // Contato da fixture tem só telefone: `chatIdOf` resolve para `@c.us`.
  const CHAT_DO_CONTATO = "5511900000002@c.us";
  const PRESA_NOWEB = "bbbbbbbb-0000-4000-8000-000000000007";
  const ECO_NOWEB = "bbbbbbbb-0000-4000-8000-000000000008";
  const DIGITADA_NO_CELULAR = "bbbbbbbb-0000-4000-8000-000000000009";
  const CONTACT_2 = "bbbbbbbb-0000-4000-8000-00000000000a";
  const CONV_2 = "bbbbbbbb-0000-4000-8000-00000000000b";
  const PRESA_OUTRA_CONVERSA = "bbbbbbbb-0000-4000-8000-00000000000c";
  const LINHA_OUTRA_CONVERSA = "bbbbbbbb-0000-4000-8000-00000000000d";
  const PRESA_WEBJS = "bbbbbbbb-0000-4000-8000-00000000000e";
  const ECO_WEBJS = "bbbbbbbb-0000-4000-8000-00000000000f";

  async function inserirPresa(id: string, body: string): Promise<void> {
    await pool.query(
      `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
                             type, direction, status, body, sent_via, sent_at, metadata)
       values ($1, $2, $3, $4, $5, 'text', 'outbound', 'queued', $6, 'ai', now(),
               '{"queued_reason":"channel_session_not_working"}')`,
      [id, ORG, CONV, SESSION, CONTACT, body],
    );
  }

  async function inserirDoCelular(
    id: string,
    conversa: string,
    contato: string,
    externalId: string,
    body: string,
  ): Promise<void> {
    await pool.query(
      `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
                             external_id, type, direction, status, body, sent_via, sent_at, metadata)
       values ($1, $2, $3, $4, $5, $6, 'text', 'outbound', 'sent', $7, 'external_device', now(),
               '{"fromMe":true}')`,
      [id, ORG, conversa, SESSION, contato, externalId, body],
    );
  }

  async function linhasCom(conversa: string, body: string) {
    const { rows } = await pool.query<{
      id: string;
      sent_via: string;
      status: string;
      external_id: string | null;
    }>(
      `select id, sent_via, status, external_id from messages
       where organization_id = $1 and conversation_id = $2 and body = $3`,
      [ORG, conversa, body],
    );
    return rows;
  }

  it("NOWEB: o eco que chegou ANTES do reenvio não deixa a frase duplicada", async () => {
    const frase = "o horário das 15h está confirmado";
    const id = "3EB0ECOANTESDOREENVIO";
    await inserirPresa(PRESA_NOWEB, frase);
    await inserirDoCelular(ECO_NOWEB, CONV, CONTACT, `true_${CHAT_DO_CONTATO}_${id}`, frase);
    // CONTROLE: o dono digitou outra coisa no celular, na mesma conversa e na
    // mesma janela. Sem ele, uma limpeza que apagasse tudo o que veio do celular
    // passaria verde neste caso.
    await inserirDoCelular(
      DIGITADA_NO_CELULAR,
      CONV,
      CONTACT,
      `true_${CHAT_DO_CONTATO}_3EB0DIGITADANOCELULAR`,
      "já separei o pedido",
    );
    proximasRespostasDoSendText.push({ id: { id } });

    const antes = sendTextCalls.length;
    expect(await redriveQueued(pool, watchdogCfg(), log)).toBe(1);
    expect(sendTextCalls).toHaveLength(antes + 1);
    // A fixture só mede alguma coisa se o eco usa o MESMO chat do reenvio.
    expect(sendTextCalls[sendTextCalls.length - 1]!.chatId).toBe(CHAT_DO_CONTATO);

    const linhas = await linhasCom(CONV, frase);
    expect(linhas, "a mesma frase ficou duas vezes na conversa").toHaveLength(1);
    expect(linhas[0]).toMatchObject({ id: PRESA_NOWEB, sent_via: "ai", status: "sent", external_id: id });

    expect(
      await linhasCom(CONV, "já separei o pedido"),
      "a limpeza apagou a mensagem que o dono digitou no celular",
    ).toHaveLength(1);
  });

  it("o eco só é procurado na conversa do reenvio — linha de OUTRA conversa não é tocada", async () => {
    const frase = "segue o orçamento";
    const id = "3EB0OUTRACONVERSA";
    await pool.query(
      `insert into contacts (id, organization_id, name, phone_number)
       values ($1, $2, 'Outra Pessoa', '+5511900000003') on conflict (id) do nothing`,
      [CONTACT_2, ORG],
    );
    await pool.query(
      `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
       values ($1, $2, $3, $4, 'open', false) on conflict (id) do nothing`,
      [CONV_2, ORG, CONTACT_2, SESSION],
    );
    await inserirPresa(PRESA_OUTRA_CONVERSA, frase);
    // O MESMO id que o reenvio vai procurar, mas em outra conversa. O único
    // filtro entre esta linha e o DELETE é o da conversa — apagar mensagem de
    // outro cliente é o pior desfecho que esta limpeza poderia ter.
    await inserirDoCelular(LINHA_OUTRA_CONVERSA, CONV_2, CONTACT_2, `true_${CHAT_DO_CONTATO}_${id}`, frase);
    proximasRespostasDoSendText.push({ id: { id } });

    expect(await redriveQueued(pool, watchdogCfg(), log)).toBe(1);

    expect(await linhasCom(CONV_2, frase), "o reenvio apagou linha de outra conversa").toHaveLength(1);
  });

  it("WEBJS: eco com o MESMO id não prende a mensagem em queued — e o tick seguinte não reenvia", async () => {
    const frase = "pode passar para retirar amanhã";
    const serializado = `true_${CHAT_DO_CONTATO}_3EB0WEBJSMESMOID`;
    await inserirPresa(PRESA_WEBJS, frase);
    await inserirDoCelular(ECO_WEBJS, CONV, CONTACT, serializado, frase);
    proximasRespostasDoSendText.push({ id: { _serialized: serializado } });

    const antes = sendTextCalls.length;
    expect(await redriveQueued(pool, watchdogCfg(), log)).toBe(1);

    const linhas = await linhasCom(CONV, frase);
    expect(linhas, "a mesma frase ficou duas vezes na conversa").toHaveLength(1);
    expect(linhas[0]).toMatchObject({
      id: PRESA_WEBJS,
      sent_via: "ai",
      status: "sent",
      external_id: serializado,
    });

    // A ARMADILHA medida pelo dono na issue #196: o UPDATE esbarra no unique
    // (organization_id, external_id) que o eco já ocupa, o catch trata como
    // "erro transiente — mantida queued", e o watchdog manda a mensagem ao
    // cliente de novo a cada tick, sem limite.
    expect(await redriveQueued(pool, watchdogCfg(), log)).toBe(0);
    expect(sendTextCalls, "o cliente recebeu a mesma mensagem de novo").toHaveLength(antes + 1);
  });
});
