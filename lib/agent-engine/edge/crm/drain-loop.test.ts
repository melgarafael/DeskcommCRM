// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { runDrainLoop } from './drain';
import { loadEnv } from '../../env';

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const knobs = { batchSize: 2, intervalMs: 2000, idleIntervalMs: 2000, debounceMs: 0, reapTimeoutMs: 60000 };
afterEach(() => vi.useRealTimers());

it('defaults reduzem polling e debounce; configuração explícita continua soberana', () => {
  const source = { NODE_ENV: 'test' as const, SUPABASE_DB_URL: 'postgres://test.invalid/db',
    NEXT_PUBLIC_SUPABASE_URL: 'https://test.invalid', SUPABASE_SERVICE_ROLE_KEY: 'fake' };
  const defaults = loadEnv(source);
  expect(defaults.CRM_DRAIN_IDLE_INTERVAL_MS).toBe(2000);
  expect(defaults.INBOUND_DEBOUNCE_MS).toBe(4000);
  const custom = loadEnv({ ...source, CRM_DRAIN_IDLE_INTERVAL_MS: '15000', INBOUND_DEBOUNCE_MS: '8000' });
  expect(custom.CRM_DRAIN_IDLE_INTERVAL_MS).toBe(15000);
  expect(custom.INBOUND_DEBOUNCE_MS).toBe(8000);
});

it.each([0, 1, 2])('lote com %s eventos respeita ritmo ocioso/ativo ou escoa backlog sem pausa', async (n) => {
  vi.useFakeTimers();
  const controller = new AbortController();
  let claims = 0;
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('returning e.id')) {
      claims++;
      if (claims === 2) controller.abort();
      // Payload inválido é consumido sem acessar banco/modelo/canal.
      return { rows: Array.from({ length: n }, (_, i) => ({ id: `e${i}`, payload: {} })) };
    }
    return { rows: [] };
  });
  const loop = runDrainLoop({ query } as unknown as pg.Pool, knobs, log, controller.signal);
  await vi.advanceTimersByTimeAsync(n === 2 ? 0 : 1999);
  if (n < 2) {
    expect(claims).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
  }
  await loop;
  expect(claims).toBe(2);
  expect(vi.getTimerCount()).toBe(0);
});

it('remove listener em cada tick e aborta a espera sem deixar timer', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const add = vi.spyOn(controller.signal, 'addEventListener');
  const remove = vi.spyOn(controller.signal, 'removeEventListener');
  const pool = { query: vi.fn(async () => ({ rows: [] })) } as unknown as pg.Pool;
  const loop = runDrainLoop(pool, knobs, log, controller.signal);
  await vi.advanceTimersByTimeAsync(6000);
  controller.abort();
  await loop;
  expect(add.mock.calls.length).toBeGreaterThan(2);
  expect(remove).toHaveBeenCalledTimes(add.mock.calls.length);
  expect(vi.getTimerCount()).toBe(0);
});
