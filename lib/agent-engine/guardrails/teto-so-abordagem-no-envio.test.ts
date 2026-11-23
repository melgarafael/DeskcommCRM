/**
 * "TETO SÓ NA ABORDAGEM" NA CADEIA DE ENVIO (#3851/#4063) — a decisão que o
 * motor recebe pronta.
 *
 * `teto-so-abordagem.test.ts` prova `decidePacing` com `abordagem` montado à mão.
 * Este arquivo prova QUEM monta o campo: `runBeforeSend`, com a cadeia real e um
 * banco falso de dois números da mesma empresa. A pessoa já recebeu mensagem pelo
 * número A e nunca pelo B.
 *
 *  1. Chave desligada (o padrão): nada muda. O disclosure (F4-05) segue contando
 *     pela EMPRESA, então o B não se reapresenta, e a consulta por número nem roda.
 *  2. Chave ligada: "já recebeu" é DESTE número. Pelo B é abordagem (conta e é
 *     barrada no teto); pelo A é follow-up (passa com o teto de abordagem batido).
 *     O disclosure continua da empresa também aqui.
 */
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import { runBeforeSend } from "@/lib/agent-engine/guardrails/before-send";
import type { Logger } from "@/lib/agent-engine/obs/logger";

const ORG = "00000000-0000-4000-8000-000000000001";
const LEAD = "00000000-0000-4000-8000-000000000002";
const JOB = "00000000-0000-4000-8000-000000000003";
const CANAL_A = "00000000-0000-4000-8000-0000000000a1";
const CANAL_B = "00000000-0000-4000-8000-0000000000b2";
const DISCLOSURE = "Sou a assistente virtual da loja.";
const CORPO = "Oi! Posso te ajudar com o pedido?";
// Terça, 10h em São Paulo: dentro da janela de disparo.
const AGORA = new Date("2026-11-10T13:00:00Z");

/** A pessoa recebeu pelo A (accepted); pelo B, nunca. */
function bancada(opcoes: { tetoSoAbordagem: boolean | null; abordagensHoje?: number; enviadosHoje?: number }) {
  const consultas: { sql: string; params: unknown[] }[] = [];
  const client = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      consultas.push({ sql, params });
      if (sql.includes("left join channel_knobs k")) {
        return {
          rows: [
            {
              throttle_ms: null, jitter_max_ms: null, window_start_hour: null, window_end_hour: null,
              resposta_start_hour: null, resposta_end_hour: null, atraso_notar_ms: null,
              ms_por_caractere: null, atraso_minimo_ms: null, atraso_maximo_ms: null,
              allow_sunday: null, teto_so_abordagem: opcoes.tetoSoAbordagem, followup_daily_cap: null,
              prospeccao_dias: null, timezone: null, warmup_daily_caps: null, number_activated_at: null,
              org_timezone: "America/Sao_Paulo",
            },
          ],
        };
      }
      if (sql.includes("as abordagens_today")) {
        return {
          rows: [
            {
              last_sent_at: null,
              sent_today: String(opcoes.enviadosHoje ?? 0),
              abordagens_today: String(opcoes.abordagensHoje ?? 0),
            },
          ],
        };
      }
      if (sql.includes("from disclosure_template_pointers")) {
        return { rows: [{ version_id: "v1", body: DISCLOSURE }] };
      }
      if (sql.includes("from send_ledger")) {
        // Sem número = a empresa (o A já mandou). Com número = só o A já mandou.
        const existe = sql.includes("join job_queue") ? params[2] === CANAL_A : true;
        return { rows: [{ existe }] };
      }
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  const pool = {
    connect: vi.fn(async () => client),
    query: vi.fn(async () => ({ rows: [{ id: "trace-1" }] })),
  } as unknown as pg.Pool;
  return { pool, consultas };
}

function loggerFalso(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

async function envia(b: ReturnType<typeof bancada>, canal: string, resposta = false) {
  const enviados: string[] = [];
  const r = await runBeforeSend({
    pool: b.pool,
    log: loggerFalso(),
    tenantId: ORG,
    leadId: LEAD,
    jobId: JOB,
    channelSessionId: canal,
    body: CORPO,
    optedOutThisTurn: false,
    crmDailyLimit: null,
    resposta,
    disclosureMode: "inject",
    now: AGORA,
    rng: () => 0,
    sleep: async () => {},
    send: async (body: string) => {
      enviados.push(body);
      return { kind: "sent", idempotencyKey: "k", messageId: "m" };
    },
  });
  return { r, enviados };
}

/** O `abordagem` gravado no `pacing_ledger` (5º parâmetro do INSERT). */
function abordagemGravada(b: ReturnType<typeof bancada>): unknown {
  const insert = b.consultas.find((c) => c.sql.includes("insert into pacing_ledger"));
  expect(insert, "o envio não gravou no pacing_ledger").toBeDefined();
  return insert?.params[4];
}

const consultouPorNumero = (b: ReturnType<typeof bancada>) =>
  b.consultas.some((c) => c.sql.includes("from send_ledger") && c.sql.includes("join job_queue"));

describe("chave desligada (o padrão): nada muda", () => {
  it("o número B NÃO reenvia o disclosure a quem o A já abordou — a conta é da empresa", async () => {
    const b = bancada({ tetoSoAbordagem: null });
    const { r, enviados } = await envia(b, CANAL_B);
    expect(r.status).toBe("sent");
    expect(enviados).toEqual([CORPO]);
    expect(consultouPorNumero(b)).toBe(false);
  });

  it("false gravado também é desligado, e a linha do ledger nasce abordagem (o default)", async () => {
    const b = bancada({ tetoSoAbordagem: false });
    await envia(b, CANAL_B);
    expect(consultouPorNumero(b)).toBe(false);
    expect(abordagemGravada(b)).toBe(true);
  });
});

describe("chave ligada: 'já recebeu' é DESTE número", () => {
  it("pelo B é abordagem: grava abordagem=true, e o disclosure segue da empresa", async () => {
    const b = bancada({ tetoSoAbordagem: true });
    const { r, enviados } = await envia(b, CANAL_B);
    expect(r.status).toBe("sent");
    expect(abordagemGravada(b)).toBe(true);
    expect(enviados).toEqual([CORPO]);
  });

  it("pelo A é follow-up: grava abordagem=false", async () => {
    const b = bancada({ tetoSoAbordagem: true });
    await envia(b, CANAL_A);
    expect(abordagemGravada(b)).toBe(false);
  });

  it("com o teto de abordagem batido (20 no dia 0), o follow-up do A sai e a abordagem do B é barrada", async () => {
    const a = await envia(bancada({ tetoSoAbordagem: true, abordagensHoje: 20, enviadosHoje: 30 }), CANAL_A);
    expect(a.r.status).toBe("sent");
    const bB = await envia(bancada({ tetoSoAbordagem: true, abordagensHoje: 20, enviadosHoje: 30 }), CANAL_B);
    expect(bB.r.status).toBe("vetoed");
    expect(bB.r.status === "vetoed" ? bB.r.code : null).toBe("warmup_cap");
  });

  it("resposta nunca é abordagem e não paga a consulta por número", async () => {
    const b = bancada({ tetoSoAbordagem: true });
    await envia(b, CANAL_B, true);
    expect(consultouPorNumero(b)).toBe(false);
    expect(abordagemGravada(b)).toBe(false);
  });
});
