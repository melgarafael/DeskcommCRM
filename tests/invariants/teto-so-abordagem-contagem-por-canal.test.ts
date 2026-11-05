import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import { decidePacing } from "@/lib/agent-engine/pacing/engine";
import { loadPacingState, recordSend } from "@/lib/agent-engine/pacing/store";

/**
 * O TETO QUE CONTA SÓ A ABORDAGEM, CONTRA O SCHEMA REAL (migration 9216, #3851).
 *
 * `channel_knobs.teto_so_abordagem` diz que o teto conta só a 1ª mensagem a
 * pessoa nova; `pacing_ledger.abordagem` é o que permite contar assim. Os testes
 * de unidade provam a REGRA com estado montado à mão; este arquivo prova a
 * CONTAGEM — o SQL de `loadPacingState` e o INSERT de `recordSend` rodando no
 * baseline — e o isolamento entre CANAIS (dois números da mesma empresa).
 *
 * Sem ele, um `and abordagem` esquecido no subselect deixaria o motor verde com
 * o teto contando follow-up como se fosse gente nova — o defeito exato que a
 * opção existe para consertar.
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
/** Dois números da MESMA empresa: a contagem é por canal, nunca por org. */
const canalA = randomUUID();
const canalB = randomUUID();
// Terça 10h em São Paulo: janela aberta, dia local de 28/07.
const AGORA = new Date("2026-07-28T13:00:00Z");
const TZ = "America/Sao_Paulo";

beforeAll(async () => {
  await pool.query(
    `insert into organizations(id,slug,legal_name,display_name,timezone)
     values($1::uuid,$1::text,'Teste Teto','Teste Teto',$2)`,
    [org, TZ],
  );
  for (const [id, nome] of [
    [canalA, "teto-a"],
    [canalB, "teto-b"],
  ] as const) {
    await pool.query(
      `insert into channel_sessions(id,organization_id,provider,waha_session_name,status,webhook_secret_encrypted)
       values($1,$2,'waha',$3,'WORKING','\\x00'::bytea)`,
      [id, org, nome],
    );
  }
});
afterAll(() => pool.end());

async function estado(canal: string) {
  return loadPacingState(pool, org, canal, { now: AGORA, timezone: TZ, numberActivatedAt: null });
}

describe("as colunas da opção existem no schema aplicado", () => {
  it("channel_knobs.teto_so_abordagem é booleana e NULLABLE (NULL = desligada)", async () => {
    const { rows } = await pool.query(
      `select data_type, is_nullable, column_default
         from information_schema.columns
        where table_name = 'channel_knobs' and column_name = 'teto_so_abordagem'`,
    );
    expect(rows).toEqual([{ data_type: "boolean", is_nullable: "YES", column_default: null }]);
  });

  it("pacing_ledger.abordagem é booleana, NOT NULL e nasce true", async () => {
    const { rows } = await pool.query(
      `select data_type, is_nullable, column_default
         from information_schema.columns
        where table_name = 'pacing_ledger' and column_name = 'abordagem'`,
    );
    expect(rows).toEqual([{ data_type: "boolean", is_nullable: "NO", column_default: "true" }]);
  });
});

describe("a contagem do dia separa abordagem de follow-up", () => {
  it("follow-up sobe sentToday mas NÃO sobe abordagensToday; resposta não sobe nenhum", async () => {
    const antes = (min: number) => new Date(AGORA.getTime() - min * 60_000);
    // Duas abordagens e três follow-ups, todos de hoje, no canal A.
    await recordSend(pool, org, canalA, antes(50));
    await recordSend(pool, org, canalA, antes(49));
    await recordSend(pool, org, canalA, antes(40), { abordagem: false });
    await recordSend(pool, org, canalA, antes(30), { abordagem: false });
    await recordSend(pool, org, canalA, antes(20), { abordagem: false });
    await recordSend(pool, org, canalA, antes(10), { resposta: true });

    const e = await estado(canalA);
    expect(e.sentToday).toBe(5); // 2 abordagens + 3 follow-ups
    expect(e.abordagensToday).toBe(2); // só as abordagens
    // O follow-up vale para o espaçamento como qualquer envio.
    expect(e.lastSentAt && new Date(e.lastSentAt).getTime()).toBe(AGORA.getTime() - 10 * 60_000);
  });

  it("o teto NÃO vaza entre canais: o canal B não vê nada do canal A", async () => {
    const a = await estado(canalA);
    const b = await estado(canalB);
    expect(a.abordagensToday).toBe(2);
    expect(b.abordagensToday).toBe(0);
    expect(b.sentToday).toBe(0);
    expect(b.lastSentAt).toBeNull();
  });

  it("motor alimentado pelo estado real: opção ligada deixa o follow-up sair e barra a abordagem", async () => {
    // Enche o canal B: 20 abordagens (o degrau do dia 0) + 3 follow-ups.
    for (let i = 0; i < 20; i += 1) {
      await recordSend(pool, org, canalB, new Date(AGORA.getTime() - (600 + i) * 1000));
    }
    for (let i = 0; i < 3; i += 1) {
      await recordSend(pool, org, canalB, new Date(AGORA.getTime() - (300 + i) * 1000), {
        abordagem: false,
      });
    }
    const e = await estado(canalB);
    expect(e.sentToday).toBe(23);
    expect(e.abordagensToday).toBe(20);

    const knobs = { ...PACING_DEFAULTS, tetoSoAbordagem: true };
    const base = { now: AGORA, knobs, state: e, crmDailyLimit: null, rng: () => 0 };

    // Follow-up de quem já foi abordado: sai, mesmo com 23 disparos no dia.
    expect(decidePacing({ ...base, abordagem: false }).allow).toBe(true);
    // Abordagem a pessoa nova: continua barrada no teto de 20.
    const abordagem = decidePacing({ ...base, abordagem: true });
    expect(abordagem.allow).toBe(false);
    if (abordagem.allow) throw new Error("inalcançável");
    expect(abordagem.code).toBe("warmup_cap");
    expect(abordagem.reason).toContain("contando só abordagem");

    // Sem a opção, o mesmo estado barra os DOIS — comportamento de hoje.
    const semOpcao = { ...base, knobs: { ...PACING_DEFAULTS, tetoSoAbordagem: false } };
    expect(decidePacing({ ...semOpcao, abordagem: false }).allow).toBe(false);
    expect(decidePacing({ ...semOpcao, resposta: true }).allow).toBe(true);
  });
});
