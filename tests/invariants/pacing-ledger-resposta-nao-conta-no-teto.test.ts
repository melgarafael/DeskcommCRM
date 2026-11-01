import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { decidePacing } from "@/lib/agent-engine/pacing/engine";
import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import { loadPacingState, recordSend } from "@/lib/agent-engine/pacing/store";

/**
 * RESPOSTA NÃO GASTA O TETO DO DIA (migration 9061).
 *
 * `pacing_ledger.resposta` marca a linha gravada pela resposta a quem escreveu;
 * `loadPacingState` só conta o que não é resposta, e `decidePacing` não aplica o
 * teto à resposta. O que este arquivo prova é a CONTAGEM CONTRA O SCHEMA REAL — o
 * SQL de `loadPacingState` e o INSERT de `recordSend` rodando no baseline —, que
 * os testes de unidade (banco falso) não alcançam. Sem ele, um `not resposta`
 * esquecido na query deixaria o motor verde e o número sem proteção.
 */

if (!process.env.TEST_DB_CONTAINER) throw new Error("rode via pnpm test:db");
const pool = new pg.Pool({
  host: "127.0.0.1",
  port: Number(process.env.TEST_DB_PORT ?? 54329),
  user: "postgres",
  password: "postgres",
  database: "postgres",
  max: 2,
});

const org = randomUUID();
const sessao = randomUUID();
// Terça 10h em São Paulo: janela comercial aberta, dia local de 28/07.
const AGORA = new Date("2026-07-28T13:00:00Z");
const TZ = "America/Sao_Paulo";

beforeAll(async () => {
  await pool.query(
    `insert into organizations(id,slug,legal_name,display_name,timezone)
     values($1::uuid,$1::text,'Teste Ledger','Teste Ledger',$2)`,
    [org, TZ],
  );
  await pool.query(
    `insert into channel_sessions(id,organization_id,provider,waha_session_name,status,webhook_secret_encrypted)
     values($1,$2,'waha','ledger-test','WORKING','\\x00'::bytea)`,
    [sessao, org],
  );
});
afterAll(() => pool.end());

async function estado() {
  return loadPacingState(pool, org, sessao, { now: AGORA, timezone: TZ, numberActivatedAt: null });
}

describe("a contagem do dia no schema real", () => {
  it("a coluna `resposta` existe, é booleana, com default false", async () => {
    const { rows } = await pool.query(
      `select data_type, column_default, is_nullable
         from information_schema.columns
        where table_name = 'pacing_ledger' and column_name = 'resposta'`,
    );
    expect(rows).toEqual([{ data_type: "boolean", column_default: "false", is_nullable: "NO" }]);
  });

  it("só o disparo sobe `sentToday`; a resposta não sobe, mas vale para o espaçamento", async () => {
    const antes = (min: number) => new Date(AGORA.getTime() - min * 60_000);
    await recordSend(pool, org, sessao, antes(50));
    await recordSend(pool, org, sessao, antes(40), {});
    await recordSend(pool, org, sessao, antes(10), { resposta: true });
    // ontem: não conta em nada de hoje
    await recordSend(pool, org, sessao, new Date(AGORA.getTime() - 26 * 3_600_000), { resposta: true });

    const e = await estado();
    expect(e.sentToday).toBe(2);
    expect(e.lastSentAt && new Date(e.lastSentAt).getTime()).toBe(AGORA.getTime() - 10 * 60_000);
  });

  it("o motor, alimentado pelo estado real: disparo barrado com o teto batido, resposta sai", async () => {
    // Encha o saldo do disparo até o degrau de warm-up do dia 0 (20).
    for (let i = 0; i < 18; i += 1) {
      await recordSend(pool, org, sessao, new Date(AGORA.getTime() - (200 + i) * 1000));
    }
    const e = await estado();
    expect(e.sentToday).toBe(20);
    const base = { now: AGORA, knobs: PACING_DEFAULTS, state: e, crmDailyLimit: null, rng: () => 0 };
    expect(decidePacing(base).allow).toBe(false);
    expect(decidePacing({ ...base, resposta: true }).allow).toBe(true);
    // prospecção prevalece sobre a resposta: abordagem fria nunca abre o teto
    expect(decidePacing({ ...base, resposta: true, prospeccao: true }).allow).toBe(false);
  });
});
