/**
 * O cron que expira pedidos pendentes não pode dar 500 contra a constraint real.
 *
 * Regressão: o UPDATE gravava `status='cancelled'` sem `cancelled_at`, e
 * `calendar_appointments_cancelamento_coerente` recusava — a rodada inteira falhava
 * e os pendentes ficavam segurando o horário para sempre.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { patchDeExpiracao } from "@/lib/agenda/patch-de-expiracao";

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
const ids = [randomUUID(), randomUUID(), randomUUID()];

beforeAll(async () => {
  await pool.query(
    `insert into organizations(id,slug,legal_name,display_name,timezone)
     values($1::uuid,$1::text,'Teste Expira','Teste Expira','America/Sao_Paulo')`,
    [org],
  );
  for (const id of ids) {
    await pool.query(
      `insert into calendar_appointments(id,organization_id,title,starts_at,ends_at,time_zone,status)
       values($1,$2,'Pedido','2030-07-03T20:30:00Z','2030-07-03T21:00:00Z','America/Sao_Paulo','pending')`,
      [id, org],
    );
  }
});
afterAll(() => pool.end());

describe("expiração de pendentes × constraint calendar_appointments_cancelamento_coerente", () => {
  it("CONTROLE: cancelar sem cancelled_at é recusado pela constraint (o 500 de produção)", async () => {
    await expect(
      pool.query(
        `update calendar_appointments set status='cancelled', cancellation_reason='x' where id=$1`,
        [ids[0]],
      ),
    ).rejects.toThrow(/calendar_appointments_cancelamento_coerente/);
  });

  it("o patch que a rota grava passa na constraint e expira TODOS os pendentes de uma vez", async () => {
    const p = patchDeExpiracao(new Date());
    const r = await pool.query(
      `update calendar_appointments
          set status=$1, cancelled_at=$2, cancellation_reason=$3
        where id = any($4::uuid[]) and status='pending'
        returning id, cancelled_at`,
      [p.status, p.cancelled_at, p.cancellation_reason, ids],
    );
    expect(r.rowCount).toBe(ids.length);
    expect(r.rows.every((x) => x.cancelled_at !== null)).toBe(true);
  });

  it("o patch cobre exatamente as colunas que a rota deve gravar", () => {
    expect(Object.keys(patchDeExpiracao(new Date())).sort()).toEqual([
      "cancellation_reason",
      "cancelled_at",
      "status",
    ]);
  });
});
