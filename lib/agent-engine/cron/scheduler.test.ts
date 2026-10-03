/**
 * O AGENDADOR NÃO DISPARA FOLLOW-UP DE ORGANIZAÇÃO PARADA.
 *
 * O cron vencido da org suspensa/redigida/arquivada avança sem enfileirar job,
 * e o one-shot se encerra. Reativar não devolve o que venceu parado: a
 * reativação é sem rajada (spec §1.3).
 */
import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';

import { tickCron } from './scheduler';

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
const AGORA = Date.parse('2026-09-29T12:00:00Z');
const HORA = 3_600_000;
const cfg = { batchSize: 1, staggerWindowMs: 0, retryBaseMs: 1000, now: () => AGORA };

function cron(over: Record<string, unknown>) {
  return {
    id: 'cron-1', organization_id: 'org-1', contact_id: 'contato-1', kind: 'every',
    interval_ms: String(HORA), cron_expr: null, tz: 'UTC', job_kind: 'followup_turn', payload: {},
    next_run_at: new Date(AGORA - 1000), enabled: true, attempts: 0, max_attempts: 5,
    last_error: null, created_at: new Date(AGORA), updated_at: new Date(AGORA), operante: false,
    ...over,
  };
}

function poolCom(linha: Record<string, unknown>) {
  const sqls: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      sqls.push({ sql, params });
      if (sql.includes('fn_org_operante')) return { rows: [linha] };
      if (sql.includes('insert into job_queue')) return { rows: [{ id: 'job-1' }] };
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  return { pool: { connect: async () => client } as unknown as pg.Pool, sqls };
}

describe('fireOneDue × organização parada', () => {
  it('recorrente: avança next_run_at, NÃO enfileira, e conta como skipped', async () => {
    const { pool, sqls } = poolCom(cron({}));
    const r = await tickCron(pool, cfg, log);
    expect(sqls.some((s) => s.sql.includes('insert into job_queue'))).toBe(false);
    const reagenda = sqls.find((s) => s.sql.startsWith('update cron_jobs set next_run_at'));
    expect(reagenda?.params).toEqual(['cron-1', new Date(AGORA - 1000 + HORA)]);
    expect(reagenda?.sql).toContain("last_error = 'org_nao_operante'");
    expect(sqls.some((s) => s.sql === 'commit')).toBe(true);
    expect(r).toEqual({ fired: 0, retried: 0, disabled: 0, skipped: 1 });
  });

  it("one-shot ('at'): se encerra (enabled=false) sem enfileirar", async () => {
    const { pool, sqls } = poolCom(cron({ kind: 'at', interval_ms: null }));
    await tickCron(pool, cfg, log);
    expect(sqls.some((s) => s.sql.includes('insert into job_queue'))).toBe(false);
    expect(sqls.some((s) => s.sql.startsWith('update cron_jobs set enabled = false'))).toBe(true);
  });

  it('org operante: enfileira como sempre (controle)', async () => {
    const { pool, sqls } = poolCom(cron({ operante: true }));
    const r = await tickCron(pool, cfg, log);
    expect(sqls.some((s) => s.sql.includes('insert into job_queue'))).toBe(true);
    expect(r.fired).toBe(1);
  });
});
