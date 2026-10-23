import http from "node:http";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelSendResult } from "@/lib/agent-engine/channel-adapter";
import { pgSendLedger, sendWithLedger } from "@/lib/agent-engine/edge/crm/send-ledger";
import { redriveQueued } from "@/lib/agent-engine/edge/crm/session-reconciler";
import { createLogger } from "@/lib/agent-engine/obs/logger";
import { audit } from "@/lib/audit";
import {
  contarEnvioAutomatico,
  desfazerContagem,
  enviarComSaidaConfiguravel,
} from "@/lib/prospecting/saida-configuravel";

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
const auditMock = vi.mocked(audit);

/**
 * Saída configurável contra o banco real (só no CI, `pnpm test:db`).
 * Chama as FUNÇÕES de `lib/prospecting/saida-configuravel.ts`, não uma cópia
 * do SQL. Cada caso semeia a própria candidata, já com a abertura enviada
 * (`automatic_sends = 1`, `status = 'sent'`), que é o estado real quando a
 * pessoa responde.
 */
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
});
afterAll(() => pool.end());

type Modo = "first_message" | "second_message";

async function novaOrganizacao(): Promise<string> {
  const org = randomUUID();
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name) values($1,$2,'Saída','Saída')",
    [org, `saida-cfg-${org.slice(0, 8)}`],
  );
  return org;
}

/** Uma candidata com conversa própria (contato e conexão próprios), abertura já enviada. */
async function candidata(org: string, modo: Modo) {
  const contato = randomUUID();
  const sessao = randomUUID();
  const conversa = randomUUID();
  const campanha = randomUUID();
  const id = randomUUID();
  await pool.query(
    "insert into contacts(id,organization_id,name,phone_number) values($1,$2,'Contato',$3)",
    [contato, org, `+55119${Math.floor(10000000 + Math.random() * 89999999)}`],
  );
  await pool.query(
    "insert into channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted) values($1,$2,$3,'\\x00'::bytea)",
    [sessao, org, `saida-${sessao.slice(0, 8)}`],
  );
  await pool.query(
    "insert into conversations(id,organization_id,contact_id,channel_session_id,status) values($1,$2,$3,$4,'open')",
    [conversa, org, contato, sessao],
  );
  // `paused`, não `running`: só pode haver UMA campanha running por organização
  // (prospecting_one_running_org) e o SQL da contagem não olha o status da campanha.
  await pool.query(
    "insert into prospecting_campaigns(id,organization_id,request_id,name,search,config,status) values($1,$2,$3,'c','{}',$4,'paused')",
    [campanha, org, randomUUID(), JSON.stringify({ exit_offer: modo })],
  );
  await pool.query(
    `insert into prospecting_candidates(id,organization_id,campaign_id,conversation_id,contact_id,status,place_id,data,automatic_sends)
     values($1,$2,$3,$4,$5,'sent',$6,'{"name":"Empresa"}',1)`,
    [id, org, campanha, conversa, contato, `place-${id.slice(0, 8)}`],
  );
  return { id, conversa, contato, sessao };
}

async function estado(org: string, id: string) {
  const { rows } = await pool.query<{ automatic_sends: number; exit_offered_at: Date | null }>(
    "select automatic_sends, exit_offered_at from prospecting_candidates where organization_id=$1 and id=$2",
    [org, id],
  );
  return rows[0]!;
}

describe("saída configurável — contagem e reserva (banco real)", () => {
  it("2ª mensagem: o 1º envio depois da abertura leva a saída; o seguinte não", async () => {
    const org = await novaOrganizacao();
    const c = await candidata(org, "second_message");
    const r1 = await contarEnvioAutomatico(pool, org, c.conversa);
    expect(r1).toMatchObject({ candidatoId: c.id, levaASaida: true, numeroDaMensagem: 2 });
    expect(r1!.reservadaEm).not.toBeNull();
    const r2 = await contarEnvioAutomatico(pool, org, c.conversa);
    expect(r2).toMatchObject({ levaASaida: false, numeroDaMensagem: 3, reservadaEm: null });
  });

  it("desfazer a contagem que reservou devolve a reserva e a contagem", async () => {
    const org = await novaOrganizacao();
    const c = await candidata(org, "second_message");
    const r = await contarEnvioAutomatico(pool, org, c.conversa);
    expect(r!.levaASaida).toBe(true);
    await desfazerContagem(pool, org, c.id, r!.reservadaEm);
    expect(await estado(org, c.id)).toEqual({ automatic_sends: 1, exit_offered_at: null });
    // a próxima volta a levar
    expect((await contarEnvioAutomatico(pool, org, c.conversa))!.levaASaida).toBe(true);
  });

  it("desfazer uma contagem que NÃO reservou não apaga a reserva de outro envio", async () => {
    const org = await novaOrganizacao();
    const c = await candidata(org, "second_message");
    await contarEnvioAutomatico(pool, org, c.conversa); // reserva
    const r2 = await contarEnvioAutomatico(pool, org, c.conversa); // não reserva
    await desfazerContagem(pool, org, c.id, r2!.reservadaEm);
    const e = await estado(org, c.id);
    expect(e.automatic_sends).toBe(2);
    expect(e.exit_offered_at).not.toBeNull();
  });

  it("a organização B não conta nem toca a candidata da organização A", async () => {
    const orgA = await novaOrganizacao();
    const orgB = await novaOrganizacao();
    const c = await candidata(orgA, "second_message");
    const antes = await estado(orgA, c.id);
    expect(await contarEnvioAutomatico(pool, orgB, c.conversa)).toBeNull();
    await desfazerContagem(pool, orgB, c.id, null);
    expect(await estado(orgA, c.id)).toEqual(antes);
  });

  it("campanha no modo padrão (1ª mensagem) nunca entra na contagem", async () => {
    const org = await novaOrganizacao();
    const c = await candidata(org, "first_message");
    expect(await contarEnvioAutomatico(pool, org, c.conversa)).toBeNull();
    expect((await estado(org, c.id)).automatic_sends).toBe(1);
  });
});

/**
 * O ENCADEAMENTO em que o defeito da prova recusada do #3091 morava: a saída
 * conta, o ledger de envio guarda, e o watchdog entrega. Ledger, contagem e
 * watchdog são os de produção; só o handler de envio é um dublê que grava a
 * linha de `messages` como o real grava (com `queued` quando a sessão está
 * fora, mantendo o corpo guardado no reprocesso) e diz o que transmitiu.
 */
describe("saída configurável — uma vez por mensagem, do envio à entrega (banco real)", () => {
  const log = createLogger();
  let waha: http.Server;
  let wahaPort = 0;
  const entreguesPeloWatchdog: Array<{ session: string; text: string }> = [];

  beforeAll(async () => {
    waha = http.createServer((req, res) => {
      let corpo = "";
      req.on("data", (c) => (corpo += c));
      req.on("end", () => {
        if (req.method === "POST" && req.url === "/api/sendText") {
          entreguesPeloWatchdog.push(JSON.parse(corpo) as { session: string; text: string });
          res.writeHead(201, { "content-type": "application/json" });
          res.end(JSON.stringify({ id: { id: `3EB0${randomUUID().slice(0, 8)}` }, timestamp: 1 }));
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    await new Promise<void>((resolve) => waha.listen(0, "127.0.0.1", resolve));
    const addr = waha.address();
    wahaPort = typeof addr === "object" && addr !== null ? addr.port : 0;
  });
  afterAll(() => new Promise<void>((resolve) => waha.close(() => resolve())));
  beforeEach(() => auditMock.mockClear());

  const watchdog = () =>
    redriveQueued(
      pool,
      {
        wahaBaseUrl: `http://127.0.0.1:${wahaPort}`,
        wahaApiKey: "k",
        intervalMs: 1000,
        redriveMinAgeMs: 0,
        redriveBatchSize: 50,
        redriveSpacingMs: 1,
      },
      log,
    );

  type Candidata = Awaited<ReturnType<typeof candidata>>;

  async function cenario() {
    const org = await novaOrganizacao();
    const c = await candidata(org, "second_message");
    // A sessão volta a WORKING só para o watchdog; o dublê é quem decide o `queued`.
    await pool.query(
      "update channel_sessions set status='WORKING' where organization_id=$1 and id=$2",
      [org, c.sessao],
    );
    return { org, c };
  }

  async function job(org: string, c: Candidata, kind: "inbound_turn" | "followup_turn") {
    const { rows } = await pool.query<{ id: string }>(
      "insert into job_queue(organization_id,kind,contact_id) values($1,$2,$3) returning id",
      [org, kind, c.contato],
    );
    return rows[0]!.id;
  }

  /** Uma tentativa de envio de (job, seq 1), com o desfecho que o canal der. */
  async function tentativa(
    org: string,
    c: Candidata,
    jobId: string,
    desfecho: "sent" | "queued" | "failed",
    texto: string,
    via: "inbound_turn" | "followup",
  ): Promise<{ resultado: ChannelSendResult; transmitido: string | null }> {
    let transmitido: string | null = null;
    const resultado = await enviarComSaidaConfiguravel(
      { db: pool, organizationId: org, conversationId: c.conversa, via, mensagem: { jobId, seq: 1 }, avisar: () => {} },
      texto,
      async (corpo) => {
        const r = await sendWithLedger(
          pgSendLedger(pool),
          { tenantId: org, leadId: c.contato, jobId, seq: 1, body: corpo },
          async (_key, messageId) => {
            const { rows } = await pool.query<{ id: string; status: string }>(
              `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
                                     type, direction, status, body, sent_via, sent_at)
               values ($1, $2, $3, $4, $5, 'text', 'outbound', $6, $7, 'ai', now())
               on conflict (id) do update set status = excluded.status
               returning id, status`,
              [messageId, org, c.conversa, c.sessao, c.contato, desfecho, corpo],
            );
            if (desfecho === "sent") transmitido = corpo;
            return rows[0]!;
          },
        );
        return r.kind === "sent"
          ? { kind: "sent", idempotencyKey: r.idempotencyKey, messageId: r.crmMessageId }
          : r.kind === "blocked"
            ? r
            : { kind: r.kind, idempotencyKey: r.idempotencyKey, messageId: r.crmMessageId };
      },
    );
    return { resultado, transmitido };
  }

  const auditoriasDaSaida = (candidatoId: string) =>
    auditMock.mock.calls.filter(
      ([e]) => e.action === "prospecting.exit_offered" && e.resourceId === candidatoId,
    ).length;

  /** A compensação é gravada pelo gatilho do banco, não pelo `audit()` do TS. */
  async function compensacoes(org: string, candidatoId: string): Promise<number> {
    const { rows } = await pool.query<{ n: number }>(
      "select count(*)::int as n from api_audit_log where organization_id=$1 and action='prospecting.exit_offer_withdrawn' and resource_id=$2",
      [org, candidatoId],
    );
    return rows[0]!.n;
  }

  async function ponteiro(org: string, candidatoId: string): Promise<string | null> {
    const { rows } = await pool.query<{ exit_offer_message_id: string | null }>(
      "select exit_offer_message_id from prospecting_candidates where organization_id=$1 and id=$2",
      [org, candidatoId],
    );
    return rows[0]!.exit_offer_message_id;
  }

  it("inbound_turn: a 2ª mensagem volta queued, o watchdog a entrega com PARAR, e a contagem fica — a 3ª não leva PARAR", async () => {
    const { org, c } = await cenario();
    const j1 = await job(org, c, "inbound_turn");
    const r1 = await tentativa(org, c, j1, "queued", "Que bom que respondeu!", "inbound_turn");
    expect(r1.resultado.kind).toBe("queued");
    const reservada = await estado(org, c.id);
    expect(reservada.automatic_sends).toBe(2);
    expect(reservada.exit_offered_at).not.toBeNull();
    expect(auditoriasDaSaida(c.id)).toBe(1);

    // O inbound_turn termina no `queued`; quem entrega é o watchdog, pelo corpo guardado.
    await watchdog();
    const daSessao = entreguesPeloWatchdog.filter((e) => e.text.startsWith("Que bom que respondeu!"));
    expect(daSessao).toHaveLength(1);
    expect(daSessao[0]!.text).toContain("responda PARAR");
    expect(await estado(org, c.id)).toEqual(reservada);
    expect(auditoriasDaSaida(c.id)).toBe(1);
    expect(await compensacoes(org, c.id)).toBe(0);

    const j2 = await job(org, c, "inbound_turn");
    const r2 = await tentativa(org, c, j2, "sent", "Posso te mostrar como funciona?", "inbound_turn");
    expect(r2.transmitido).toBe("Posso te mostrar como funciona?");
    expect(await estado(org, c.id)).toEqual({ ...reservada, automatic_sends: 3 });
    expect(auditoriasDaSaida(c.id)).toBe(1);
  });

  it("followup_turn: queued e nova tentativa do mesmo job com o canal de volta — conta uma vez e a nova tentativa transmite o PARAR", async () => {
    const { org, c } = await cenario();
    const j = await job(org, c, "followup_turn");
    await tentativa(org, c, j, "queued", "Passando para lembrar", "followup");
    const reservada = await estado(org, c.id);
    expect(reservada.automatic_sends).toBe(2);
    expect(reservada.exit_offered_at).not.toBeNull();

    const r = await tentativa(org, c, j, "sent", "Passando para lembrar", "followup");
    expect(r.resultado.kind).toBe("sent");
    expect(r.transmitido).toContain("responda PARAR");
    expect(await estado(org, c.id)).toEqual(reservada);
    expect(auditoriasDaSaida(c.id)).toBe(1);
  });

  it("followup_turn: queued, o watchdog entrega primeiro, e a nova tentativa não conta nem transmite", async () => {
    const { org, c } = await cenario();
    const j = await job(org, c, "followup_turn");
    await tentativa(org, c, j, "queued", "Lembrete do watchdog", "followup");
    const reservada = await estado(org, c.id);
    await watchdog();
    expect(entreguesPeloWatchdog.some((e) => e.text.startsWith("Lembrete do watchdog") && e.text.includes("PARAR"))).toBe(true);

    const r = await tentativa(org, c, j, "sent", "Lembrete do watchdog", "followup");
    expect(r.resultado.kind).toBe("sent");
    expect(r.transmitido).toBeNull();
    expect(await estado(org, c.id)).toEqual(reservada);
    expect(auditoriasDaSaida(c.id)).toBe(1);
  });

  it("failed desfaz; a nova tentativa (chave rotacionada) conta e leva a saída", async () => {
    const { org, c } = await cenario();
    const j = await job(org, c, "followup_turn");
    const r1 = await tentativa(org, c, j, "failed", "Oi de novo", "followup");
    expect(r1.resultado.kind).toBe("failed");
    expect(await estado(org, c.id)).toEqual({ automatic_sends: 1, exit_offered_at: null });
    expect(auditoriasDaSaida(c.id)).toBe(0);

    const r2 = await tentativa(org, c, j, "sent", "Oi de novo", "followup");
    expect(r2.transmitido).toContain("responda PARAR");
    expect((await estado(org, c.id)).automatic_sends).toBe(2);
    expect(auditoriasDaSaida(c.id)).toBe(1);
  });

  it("already_sent (o mesmo job re-rodado depois de sair) não conta de novo", async () => {
    const { org, c } = await cenario();
    const j = await job(org, c, "inbound_turn");
    await tentativa(org, c, j, "sent", "Primeira resposta", "inbound_turn");
    const contada = await estado(org, c.id);
    expect(contada.automatic_sends).toBe(2);

    const r = await tentativa(org, c, j, "sent", "Primeira resposta", "inbound_turn");
    expect(r.resultado.kind).toBe("already_sent");
    expect(r.transmitido).toBeNull();
    expect(await estado(org, c.id)).toEqual(contada);
    expect(auditoriasDaSaida(c.id)).toBe(1);
  });

  // O inverso do defeito original, achado pelo cético: a mensagem guardada com o
  // PARAR NÃO sai — o canal é pausado e o watchdog a falha. A reserva estava
  // amarrada a ela, então volta, e a mensagem seguinte é a que leva a saída.
  it("inbound_turn: queued, o canal é pausado e o watchdog falha a mensagem — a reserva volta e a seguinte leva PARAR", async () => {
    const { org, c } = await cenario();
    const j1 = await job(org, c, "inbound_turn");
    await tentativa(org, c, j1, "queued", "Cetico A guardada", "inbound_turn");
    expect((await estado(org, c.id)).automatic_sends).toBe(2);
    expect(await ponteiro(org, c.id)).not.toBeNull();

    await pool.query(
      `update channel_sessions set metadata = coalesce(metadata,'{}'::jsonb) || '{"disabled":true}'::jsonb where organization_id=$1 and id=$2`,
      [org, c.sessao],
    );
    await watchdog();
    expect(entreguesPeloWatchdog.some((e) => e.text.startsWith("Cetico A guardada"))).toBe(false);
    const { rows: msg } = await pool.query<{ status: string; error_code: string | null }>(
      "select m.status, m.error_code from messages m join send_ledger l on l.organization_id=m.organization_id and l.crm_message_id=m.id where l.organization_id=$1 and l.job_id=$2",
      [org, j1],
    );
    expect(msg).toEqual([{ status: "failed", error_code: "channel_disabled" }]);
    expect(await estado(org, c.id)).toEqual({ automatic_sends: 1, exit_offered_at: null });
    expect(await ponteiro(org, c.id)).toBeNull();
    expect(await compensacoes(org, c.id)).toBe(1);

    await pool.query(
      `update channel_sessions set metadata = metadata - 'disabled' where organization_id=$1 and id=$2`,
      [org, c.sessao],
    );
    const j2 = await job(org, c, "inbound_turn");
    const r2 = await tentativa(org, c, j2, "sent", "Cetico A seguinte", "inbound_turn");
    expect(r2.transmitido).toContain("responda PARAR");
    expect((await estado(org, c.id)).automatic_sends).toBe(2);
    expect(auditoriasDaSaida(c.id)).toBe(2);
    expect(await compensacoes(org, c.id)).toBe(1);
  });

  it("followup_turn: queued e a nova tentativa do MESMO job volta failed — desfaz uma vez, e a seguinte (chave rotacionada) leva PARAR", async () => {
    const { org, c } = await cenario();
    const j = await job(org, c, "followup_turn");
    await tentativa(org, c, j, "queued", "Cetico B", "followup");
    expect((await estado(org, c.id)).automatic_sends).toBe(2);

    const r2 = await tentativa(org, c, j, "failed", "Cetico B", "followup");
    expect(r2.resultado.kind).toBe("failed");
    expect(await estado(org, c.id)).toEqual({ automatic_sends: 1, exit_offered_at: null });
    expect(await compensacoes(org, c.id)).toBe(1);

    const r3 = await tentativa(org, c, j, "sent", "Cetico B", "followup");
    expect(r3.transmitido).toContain("responda PARAR");
    expect((await estado(org, c.id)).automatic_sends).toBe(2);
    expect((await estado(org, c.id)).exit_offered_at).not.toBeNull();
    expect(await compensacoes(org, c.id)).toBe(1);
  });

  it("o failed chega ANTES de a reserva ser amarrada — quem desfaz é a própria tentativa, e não audita", async () => {
    const { org, c } = await cenario();
    const j = await job(org, c, "inbound_turn");
    const resultado = await enviarComSaidaConfiguravel(
      { db: pool, organizationId: org, conversationId: c.conversa, via: "inbound_turn", mensagem: { jobId: j, seq: 1 }, avisar: () => {} },
      "Corrida",
      async (corpo) => {
        const r = await sendWithLedger(
          pgSendLedger(pool),
          { tenantId: org, leadId: c.contato, jobId: j, seq: 1, body: corpo },
          async (_key, messageId) => {
            const { rows } = await pool.query<{ id: string; status: string }>(
              `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
                                     type, direction, status, body, sent_via, sent_at)
               values ($1, $2, $3, $4, $5, 'text', 'outbound', 'queued', $6, 'ai', now())
               returning id, status`,
              [messageId, org, c.conversa, c.sessao, c.contato, corpo],
            );
            return rows[0]!;
          },
        );
        if (r.kind === "blocked") return r;
        // O watchdog falha a mensagem entre o handler devolver e a reserva ser amarrada.
        await pool.query("update messages set status='failed' where organization_id=$1 and id=$2", [org, r.crmMessageId]);
        return { kind: "queued", idempotencyKey: r.idempotencyKey, messageId: r.crmMessageId };
      },
    );
    expect(resultado.kind).toBe("queued");
    expect(await estado(org, c.id)).toEqual({ automatic_sends: 1, exit_offered_at: null });
    expect(auditoriasDaSaida(c.id)).toBe(0);
    expect(await compensacoes(org, c.id)).toBe(0);
  });
});
