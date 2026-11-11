import type pg from 'pg';
import { describe, expect, it } from 'vitest';

import {
  CACHE_RATIO_METRIC,
  CACHEABLE_INPUT_TOKENS_MIN,
  QUEUE_WAIT_METRIC,
  WALL_METRIC,
  evaluateCacheHitAlert,
  recordRunMetrics,
} from './metrics';

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

/**
 * #4362 — o aviso de cache contava no denominador chamadas que NUNCA vão para
 * cache: o provedor só guarda prefixo a partir de 1.024 tokens de ENTRADA, e os
 * classificadores ficam abaixo disso. No relato do autor, `agent_turn` a 40,9% e
 * `checkpoint` a 0,2% (com ~3.700 tokens por chamada) arrastavam a média e o
 * aviso reabria sozinho.
 *
 * O dublê abaixo aplica o MESMO recorte que a consulta pede: se o SQL filtrou as
 * chamadas cacheáveis, soma só elas; se não filtrou — a versão com o defeito —,
 * devolve o total. Assim a falta do recorte aparece como NÚMERO errado, e não
 * como um teste que só confere o texto do SQL.
 */
interface ChamadaFalsa {
  purpose: string;
  provider: string;
  input_tokens: number;
  cache_read_tokens: number;
}

function poolComChamadas(chamadas: ChamadaFalsa[]) {
  const consultas: Array<{ sql: string; params: unknown[] }> = [];
  const filtro = `input_tokens >= ${CACHEABLE_INPUT_TOKENS_MIN}`;
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      consultas.push({ sql, params });
      if (sql.includes('from llm_calls')) {
        // Os totais são de todas as chamadas; o recorte cacheável só existe se a
        // consulta pediu o filtro. Sem o filtro, o classificador entra na razão —
        // é exatamente o defeito que o teste cobra.
        const cacheaveis = sql.includes(filtro)
          ? chamadas.filter((c) => c.input_tokens >= CACHEABLE_INPUT_TOKENS_MIN)
          : chamadas;
        const soma = (lista: ChamadaFalsa[], ler: (c: ChamadaFalsa) => number): number =>
          lista.reduce((t, c) => t + ler(c), 0);
        return {
          rows: [
            {
              calls: chamadas.length,
              input_tokens: soma(chamadas, (c) => c.input_tokens),
              output_tokens: 0,
              cache_read_tokens: soma(chamadas, (c) => c.cache_read_tokens),
              cacheable_calls: cacheaveis.length,
              cacheable_input_tokens: soma(cacheaveis, (c) => c.input_tokens),
              cacheable_cache_read_tokens: soma(cacheaveis, (c) => c.cache_read_tokens),
              cost_cents: null,
              llm_latency_ms: 0,
            },
          ],
        };
      }
      return { rows: [] };
    },
  };
  return { pool: pool as unknown as pg.Pool, consultas };
}

describe('recordRunMetrics: razão de cache só com chamadas cacheáveis (#4362)', () => {
  it('soma no denominador apenas a chamada cacheável — a de 800 tokens fica fora', async () => {
    const { pool, consultas } = poolComChamadas([
      // chamada principal do turno: 3.700 tokens de entrada, 50% já em cache
      { purpose: 'agent_turn', provider: 'anthropic', input_tokens: 3_700, cache_read_tokens: 1_850 },
      // classificador: 800 tokens de entrada — nunca entra em cache
      { purpose: 'classifier', provider: 'anthropic', input_tokens: 800, cache_read_tokens: 700 },
    ]);

    await recordRunMetrics(pool, JOB);

    const ins = insertDe(consultas);
    const i = ins.names.indexOf(CACHE_RATIO_METRIC);
    expect(i).toBeGreaterThanOrEqual(0);
    // 1.850 / 3.700. Com o classificador na conta daria 2.550 / 4.500 = 56,7%.
    expect(ins.values[i]).toBeCloseTo(0.5, 6);
    // os totais do run seguem sendo o total de todas as chamadas (custo real)
    expect(ins.values[ins.names.indexOf('run_input_tokens')]).toBe(4_500);
    expect(consultas.some((c) => c.sql.includes(`input_tokens >= ${CACHEABLE_INPUT_TOKENS_MIN}`))).toBe(true);
  });

  it('run só com classificador não grava razão: não há chamada cacheável a medir', async () => {
    const { pool, consultas } = poolComChamadas([
      { purpose: 'classifier', provider: 'anthropic', input_tokens: 800, cache_read_tokens: 700 },
    ]);

    await recordRunMetrics(pool, JOB);

    const ins = insertDe(consultas);
    expect(ins.names).not.toContain(CACHE_RATIO_METRIC);
    expect(ins.names).toContain('run_llm_calls');
  });

  it('controle positivo: todas as chamadas cacheáveis e a razão é a esperada', async () => {
    const { pool, consultas } = poolComChamadas([
      { purpose: 'agent_turn', provider: 'anthropic', input_tokens: 3_000, cache_read_tokens: 2_580 },
    ]);

    await recordRunMetrics(pool, JOB);

    const ins = insertDe(consultas);
    expect(ins.values[ins.names.indexOf(CACHE_RATIO_METRIC)]).toBeCloseTo(0.86, 6);
  });
});

interface GrupoFalso {
  purpose: string;
  provider: string;
  calls: number;
  input_tokens: number;
  cache_read_tokens: number;
}

/**
 * Dublê do alerta: a contagem de runs vem de `metrics` (amostra mínima) e o
 * recorte vem de `llm_calls`. O `avg_ratio` das métricas antigas é 0,2 — a média
 * diluída pelo classificador, que é justamente o que não pode mais decidir o aviso.
 */
function poolDoAlerta(runs: number, grupos: GrupoFalso[]) {
  const consultas: Array<{ sql: string; params: unknown[] }> = [];
  const inserts: unknown[][] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      consultas.push({ sql, params });
      if (sql.includes('from metrics')) {
        return { rows: [{ runs, avg_ratio: 0.2 }] };
      }
      if (sql.includes('from llm_calls')) {
        return { rows: grupos };
      }
      if (sql.includes('insert into agent_inbox_items')) {
        inserts.push(params);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [] };
    },
  };
  return { pool: pool as unknown as pg.Pool, consultas, inserts };
}

const KNOBS = { windowMs: 86_400_000, cacheHitAlertThreshold: 0.4, cacheHitAlertMinRuns: 3 };

describe('evaluateCacheHitAlert: decidido só pelas chamadas cacheáveis (#4362)', () => {
  it('não dispara com o recorte cacheável acima do alvo, ainda que a métrica antiga esteja em 20%', async () => {
    // 36.000/60.000 = 60% no agent_turn; 50/10.000 = 0,5% no checkpoint;
    // ponderado = 36.050/70.000 = 51,5% — acima do alvo.
    const { pool, inserts } = poolDoAlerta(5, [
      { purpose: 'agent_turn', provider: 'anthropic', calls: 30, input_tokens: 60_000, cache_read_tokens: 36_000 },
      { purpose: 'checkpoint', provider: 'anthropic', calls: 3, input_tokens: 10_000, cache_read_tokens: 50 },
    ]);

    const res = await evaluateCacheHitAlert(pool, 'org-1', KNOBS);

    expect(res.alerted).toBe(false);
    expect(res.avgRatio).toBeCloseTo(36_050 / 70_000, 6);
    expect(inserts).toHaveLength(0);
  });

  it('sem chamada cacheável na janela não há razão a avaliar — e nada é afirmado', async () => {
    const { pool, inserts } = poolDoAlerta(5, []);

    const res = await evaluateCacheHitAlert(pool, 'org-1', KNOBS);

    expect(res.avgRatio).toBeNull();
    expect(res.alerted).toBe(false);
    expect(inserts).toHaveLength(0);
  });

  it('dispara abaixo do alvo e mostra o recorte por finalidade e por provedor no texto', async () => {
    // agent_turn 10.000/50.000 = 20%; checkpoint 23/10.000 = 0,23%;
    // ponderado = 10.023/60.000 = 16,7%
    const { pool, inserts } = poolDoAlerta(318, [
      { purpose: 'agent_turn', provider: 'anthropic', calls: 10, input_tokens: 50_000, cache_read_tokens: 10_000 },
      { purpose: 'checkpoint', provider: 'anthropic', calls: 318, input_tokens: 10_000, cache_read_tokens: 23 },
    ]);

    const res = await evaluateCacheHitAlert(pool, 'org-1', KNOBS);

    expect(res.alerted).toBe(true);
    expect(inserts).toHaveLength(1);
    const body = String(inserts[0]?.[1] ?? '');
    expect(body).toContain('16.7%');
    expect(body).toContain('alvo ≥ 40%');
    expect(body).toContain('agent_turn 20.0% (10 chamadas)');
    expect(body).toContain('checkpoint 0.2% (318 chamadas)');
    expect(body).toContain('anthropic 16.7% (328 chamadas)');
    // o texto antigo afirmava uma causa não medida
    expect(body).not.toContain('Prefixo do prompt possivelmente');
  });
});
