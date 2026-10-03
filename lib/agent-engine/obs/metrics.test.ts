import type pg from 'pg';
import { describe, expect, it } from 'vitest';

import { QUEUE_WAIT_METRIC, WALL_METRIC, recordRunMetrics } from './metrics';

/**
 * Sem estas duas métricas não há régua para "a IA demora": o que existia era a
 * soma das latências das chamadas de modelo, que não vê a fila nem o turno.
 * O banco é um dublê que só registra as consultas: o que se confere é o que o
 * worker manda gravar, e de onde vem cada instante.
 */
function poolFalso(llmCalls: number) {
  const consultas: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      consultas.push({ sql, params });
      if (sql.includes('from llm_calls')) {
        return {
          rows: [
            {
              calls: llmCalls,
              input_tokens: 1000,
              output_tokens: 100,
              cache_read_tokens: 800,
              cost_cents: 1.5,
              llm_latency_ms: 2000,
            },
          ],
        };
      }
      return { rows: [] };
    },
  };
  return { pool: pool as unknown as pg.Pool, consultas };
}

const JOB = {
  id: '11111111-1111-4111-8111-111111111111',
  organization_id: '22222222-2222-4222-8222-222222222222',
  contact_id: '33333333-3333-4333-8333-333333333333',
  kind: 'inbound_turn' as const,
  created_at: new Date('2026-10-02T12:00:00.000Z'),
  // o texto que o claim devolve (`locked_at::text`), no formato do Postgres
  claim_acquired_at: '2026-10-02 12:00:07.250000+00',
};

function insertDe(consultas: Array<{ sql: string; params: unknown[] }>) {
  const insert = consultas.find((c) => c.sql.includes('insert into metrics'));
  if (!insert) throw new Error('nenhuma métrica foi gravada');
  const [org, labels, names, values, claim] = insert.params as [string, string, string[], number[], string | null];
  return { sql: insert.sql, org, labels: JSON.parse(labels) as Record<string, unknown>, names, values, claim };
}

describe('recordRunMetrics: tempo de fila e duração do job', () => {
  it('grava a espera na fila como claim − created_at', async () => {
    const { pool, consultas } = poolFalso(3);
    const calls = await recordRunMetrics(pool, JOB);

    expect(calls).toBe(3);
    const ins = insertDe(consultas);
    const i = ins.names.indexOf(QUEUE_WAIT_METRIC);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(ins.values[i]).toBe(7250);
  });

  it('a duração do job sai do relógio do banco, a partir do claim — nunca de locked_at', async () => {
    const { pool, consultas } = poolFalso(3);
    await recordRunMetrics(pool, JOB);

    const ins = insertDe(consultas);
    expect(ins.sql).toContain(`'${WALL_METRIC}'`);
    expect(ins.sql).toContain('clock_timestamp() - $5::timestamptz');
    expect(ins.claim).toBe(JOB.claim_acquired_at);
    expect(consultas.some((c) => c.sql.includes('locked_at'))).toBe(false);
  });

  it('job sem chamada de modelo ainda grava os tempos, e devolve 0 para o alerta de cache', async () => {
    const { pool, consultas } = poolFalso(0);
    const calls = await recordRunMetrics(pool, JOB);

    expect(calls).toBe(0);
    const ins = insertDe(consultas);
    expect(ins.names).toEqual([QUEUE_WAIT_METRIC]);
  });

  it('labels só com ids — nada de conteúdo da conversa', async () => {
    const { pool, consultas } = poolFalso(1);
    await recordRunMetrics(pool, JOB);

    expect(insertDe(consultas).labels).toEqual({
      job_id: JOB.id,
      contact_id: JOB.contact_id,
      kind: JOB.kind,
    });
  });

  it('sem claim conhecido e sem chamada, não grava nada', async () => {
    const { pool, consultas } = poolFalso(0);
    const calls = await recordRunMetrics(pool, { ...JOB, claim_acquired_at: undefined });

    expect(calls).toBe(0);
    expect(consultas.some((c) => c.sql.includes('insert into metrics'))).toBe(false);
  });
});
