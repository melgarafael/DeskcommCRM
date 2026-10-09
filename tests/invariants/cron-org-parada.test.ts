import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { tickCron } from "@/lib/agent-engine/cron/scheduler";
import { createLogger } from "@/lib/agent-engine/obs/logger";

/**
 * O SQL REAL do agendador com a régua (migration 0501).
 *
 * `fireOneDue` chama `public.fn_org_operante(organization_id)` dentro do
 * `select … for update skip locked`, pelo pool `pg` do worker. O teste unitário
 * usa dublê; só aqui o Postgres executa o SQL com o papel do pool — um erro de
 * sintaxe ou de EXECUTE pararia TODOS os follow-ups da instalação.
 * Conexão copiada de `agent-watchdog.test.ts`.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});
const log = createLogger();

const ORG_PARADA = "c0de0496-8888-4000-8000-00000000000a";
const ORG_ATIVA = "c0de0496-8888-4000-8000-00000000000b";
const CONTATO = "c0de0496-8888-4000-8000-0000000000c1";
const CRON_RECORRENTE = "c0de0496-8888-4000-8000-0000000000d1";
const CRON_UNICO = "c0de0496-8888-4000-8000-0000000000d2";
const HORA = 3_600_000;
/**
 * `tickCron` reivindica QUALQUER cron vencido do banco compartilhado, na ordem
 * de `next_run_at` (`scheduler.ts:208-211`), e o `test:db` roda os arquivos em
 * ordem embaralhada (`--sequence.shuffle.files=true`). Com os NOSSOS dois crons
 * vencidos em 2000 — antes de qualquer cron que outro arquivo semeie — e
 * `batchSize: 2`, o tick pega exatamente os dois e não dispara cron alheio.
 * As asserções medem só as nossas linhas.
 */
const VENCIDO_EM = "2000-01-01T00:00:00Z";

beforeAll(async () => {
  await pool.query(`
    insert into public.organizations (id, slug, legal_name, display_name, status, suspended_kind, suspended_at) values
      ('${ORG_PARADA}', 'cron-0501-parada', 'Parada', 'Parada', 'suspended', 'administrativa', now()),
      ('${ORG_ATIVA}', 'cron-0501-ativa', 'Ativa', 'Ativa', 'active', null, null)
      on conflict (id) do nothing;
    insert into public.contacts (id, organization_id, display_name)
      values ('${CONTATO}', '${ORG_PARADA}', 'Contato cron 0501') on conflict (id) do nothing;
    insert into public.cron_jobs (id, organization_id, contact_id, kind, interval_ms, job_kind, next_run_at) values
      ('${CRON_RECORRENTE}', '${ORG_PARADA}', '${CONTATO}', 'every', ${HORA}, 'followup_turn', '${VENCIDO_EM}'),
      ('${CRON_UNICO}', '${ORG_PARADA}', '${CONTATO}', 'at', null, 'followup_turn', '${VENCIDO_EM}')
      on conflict (id) do nothing;
  `);
});

afterAll(async () => {
  await pool.end();
});

describe("tickCron × organização parada, no Postgres real", () => {
  it("controle: o papel do pool executa fn_org_operante e a régua responde", async () => {
    const { rows } = await pool.query<{ parada: boolean; ativa: boolean }>(
      "select public.fn_org_operante($1) as parada, public.fn_org_operante($2) as ativa",
      [ORG_PARADA, ORG_ATIVA],
    );
    expect(rows[0]).toEqual({ parada: false, ativa: true });
  });

  it("os vencidos da org parada avançam/encerram sem job, com last_error org_nao_operante", async () => {
    await tickCron(pool, { batchSize: 2, staggerWindowMs: 0, retryBaseMs: 1000 }, log);
    // Só as NOSSAS linhas: nenhuma delas pode seguir vencida e habilitada.
    const { rows: pendentes } = await pool.query(
      "select count(*)::int as n from public.cron_jobs where id in ($1, $2) and enabled and next_run_at <= now()",
      [CRON_RECORRENTE, CRON_UNICO],
    );
    expect(pendentes[0].n, "o tick não reivindicou os dois crons da org parada").toBe(0);
    const { rows: jobs } = await pool.query("select count(*)::int as n from public.job_queue where organization_id = $1", [ORG_PARADA]);
    expect(jobs[0].n).toBe(0);
    const { rows: crons } = await pool.query<{ id: string; enabled: boolean; last_error: string; futuro: boolean }>(
      "select id, enabled, last_error, next_run_at > now() as futuro from public.cron_jobs where id in ($1, $2) order by id",
      [CRON_RECORRENTE, CRON_UNICO],
    );
    expect(crons).toEqual([
      { id: CRON_RECORRENTE, enabled: true, last_error: "org_nao_operante", futuro: true },
      { id: CRON_UNICO, enabled: false, last_error: "org_nao_operante", futuro: false },
    ]);
  });
});
