import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';

import {
  runBeforeSend,
  semanticPromiseGate,
  type Gate,
  type RunBeforeSendArgs,
} from '@/lib/agent-engine/guardrails/before-send';
import {
  memoizarPorCandidata,
  type PromiseClassification,
} from '@/lib/agent-engine/guardrails/promise/semantic';

/**
 * A CONFERÊNCIA SEMÂNTICA DE PROMESSA NÃO SEGURA O NÚMERO.
 *
 * `classifyPromiseSemantic` é uma ida e volta ao modelo POR ENVIO. Ela rodava
 * dentro da transação de `runBeforeSend`, com o `pg_advisory_xact_lock` do
 * número na mão: todo outro envio do MESMO WhatsApp esperava a IA, e a conexão
 * ficava presa durante a chamada. O veredito só depende do corpo, então ele é
 * calculado ANTES de tomar conexão — junto com a pausa humana, não depois dela.
 *
 * Mesma régua de posição de `espera-humana-fora-do-lock-do-numero.test.ts`:
 * mede-se a ORDEM dos eventos num pool fingido; contenção real sob carga é do
 * job de integração.
 */

type Eventos = string[];

function poolFalso(eventos: Eventos) {
  const client = {
    query: vi.fn(async (sql: string): Promise<{ rows: unknown[] }> => {
      const s = String(sql).toLowerCase().trim();
      if (s.includes('pg_advisory_xact_lock')) eventos.push('lock');
      if (s === 'begin') eventos.push('begin');
      if (s === 'commit') eventos.push('commit');
      if (s === 'rollback') eventos.push('rollback');
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  const pool = {
    connect: vi.fn(async () => {
      eventos.push('connect');
      return client;
    }),
    query: vi.fn().mockResolvedValue({ rows: [{ id: 'trace-1' }] }),
  };
  return { pool: pool as unknown as pg.Pool, cru: pool, client };
}

function args(pool: pg.Pool, extras: Partial<RunBeforeSendArgs> = {}): RunBeforeSendArgs {
  return {
    pool,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    tenantId: '00000000-0000-4000-8000-000000000001',
    leadId: '00000000-0000-4000-8000-000000000002',
    jobId: '00000000-0000-4000-8000-000000000003',
    channelSessionId: '00000000-0000-4000-8000-000000000004',
    body: 'Consigo te dar 50% de desconto hoje.',
    optedOutThisTurn: false,
    crmDailyLimit: null,
    now: new Date('2026-09-17T12:00:00.000Z'),
    rng: () => 0,
    sleep: async () => {},
    gates: [],
    send: async () => ({ kind: 'sent', idempotencyKey: 'k', messageId: 'm' }),
    ...extras,
  };
}

const NAO_E_PROMESSA: PromiseClassification = {
  isPromise: false,
  suspectPhrase: null,
  prometeuRetornoHumano: false,
  retornoSoDoAssistente: false,
};

describe('a conferência semântica roda fora da posse do lock do número', () => {
  it('a classificação termina antes de o guardrail tomar conexão', async () => {
    const eventos: Eventos = [];
    const { pool } = poolFalso(eventos);
    const r = await runBeforeSend(
      args(pool, {
        classifyPromiseSemantic: async () => {
          eventos.push('classificou');
          return NAO_E_PROMESSA;
        },
      }),
    );
    expect(r.status).toBe('sent');
    expect(eventos).toEqual(['classificou', 'connect', 'begin', 'lock', 'commit']);
  });

  it('roda JUNTO com a pausa humana — o cliente espera o maior dos dois, não a soma', async () => {
    const eventos: Eventos = [];
    const { pool } = poolFalso(eventos);
    let liberarEspera!: () => void;
    const espera = new Promise<void>((resolve) => (liberarEspera = resolve));
    const envio = runBeforeSend(
      args(pool, {
        esperaForaDoLock: async () => {
          eventos.push('espera:inicio');
          await espera;
          eventos.push('espera:fim');
        },
        classifyPromiseSemantic: async () => {
          eventos.push('classificou');
          return NAO_E_PROMESSA;
        },
      }),
    );
    // A pausa ainda não acabou, e a classificação já correu.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(eventos).toEqual(['espera:inicio', 'classificou']);
    liberarEspera();
    await envio;
    expect(eventos.indexOf('connect')).toBeGreaterThan(eventos.indexOf('espera:fim'));
  });

  it('o veredito continua chegando aos gates, e classifica o corpo DEPOIS do estilo', async () => {
    const eventos: Eventos = [];
    const { pool } = poolFalso(eventos);
    const classificar = vi.fn(
      async (_corpo: string): Promise<PromiseClassification> => ({
        isPromise: true,
        suspectPhrase: '50% de desconto',
        prometeuRetornoHumano: false,
        retornoSoDoAssistente: false,
      }),
    );
    const vistos: unknown[] = [];
    const r = await runBeforeSend(
      args(pool, {
        classifyPromiseSemantic: classificar,
        gates: [
          {
            name: 'espiao',
            evaluate: (ctx) => {
              vistos.push(ctx.semanticPromise);
              return { pass: true };
            },
          } satisfies Gate,
        ],
      }),
    );
    expect(r.status).toBe('sent');
    expect(classificar).toHaveBeenCalledWith('Consigo te dar 50% de desconto hoje.');
    expect(vistos).toEqual([
      { isPromise: true, suspectPhrase: '50% de desconto', prometeuRetornoHumano: false, retornoSoDoAssistente: false },
    ]);
  });

  it('falha do classificador sobe SEM abrir conexão nem transação', async () => {
    const eventos: Eventos = [];
    const { pool, cru } = poolFalso(eventos);
    await expect(
      runBeforeSend(
        args(pool, {
          classifyPromiseSemantic: async () => {
            throw new Error('upstream 503');
          },
        }),
      ),
    ).rejects.toThrow('upstream 503');
    expect(cru.connect).not.toHaveBeenCalled();
    expect(eventos).toEqual([]);
  });
});

describe('memoizarPorCandidata — a mesma frase não é paga duas vezes no turno', () => {
  it('o re-run do fail-safe com o mesmo corpo reaproveita a classificação', async () => {
    const classificar = vi.fn(async (_c: string): Promise<PromiseClassification> => NAO_E_PROMESSA);
    const memo = memoizarPorCandidata(classificar);
    await memo('frase A');
    await memo('frase A');
    await memo('frase B');
    expect(classificar.mock.calls.map((c) => c[0])).toEqual(['frase A', 'frase B']);
  });

  it('falha não fica no memo — a passagem seguinte tenta de novo', async () => {
    let vez = 0;
    const memo = memoizarPorCandidata(async () => {
      vez += 1;
      if (vez === 1) throw new Error('upstream 503');
      return NAO_E_PROMESSA;
    });
    await expect(memo('frase')).rejects.toThrow('upstream 503');
    await expect(memo('frase')).resolves.toEqual(NAO_E_PROMESSA);
    expect(vez).toBe(2);
  });
});

describe('memoizarPorCandidata — evidência nova invalida o veredito de antes', () => {
  it('a mesma frase depois de o modelo consultar o preço é classificada de novo', async () => {
    let evidencias: string[] = [];
    const classificar = vi.fn(async (_c: string): Promise<PromiseClassification> => NAO_E_PROMESSA);
    const memo = memoizarPorCandidata(classificar, () => JSON.stringify(evidencias));
    await memo('faço por R$ 90');
    await memo('faço por R$ 90');
    evidencias = ['catalogo:produto-1'];
    await memo('faço por R$ 90');
    expect(classificar).toHaveBeenCalledTimes(2);
  });
});

/**
 * Da bancada de @AlecsanderAbreu (#2363), que mediu numa VPS o que a posição
 * antiga custava: com o classificador dentro da transação, um DDL na fila de
 * `contacts` fechava um ciclo de travas que o Postgres não detecta (8m47s
 * `idle in transaction`, worker parado). Os casos de ORDEM acima já prendem a
 * posição; estes prendem o que a ordem sozinha não diz: a posse do lock não
 * contém o tempo do modelo, o corpo julgado é o enviado, e o veto real continua
 * desfazendo a transação.
 */
describe('a posse do número não contém o classificador (bancada do #2363)', () => {
  it('a janela begin→commit não contém o tempo do classificador', async () => {
    const eventos: Eventos = [];
    const { pool, client } = poolFalso(eventos);
    const CLASSIFICADOR_MS = 40;
    let posseInicio = 0;
    let posseFim = 0;
    const original = client.query;
    client.query = vi.fn(async (sql: string) => {
      const s = String(sql).toLowerCase().trim();
      if (s === 'begin') posseInicio = performance.now();
      if (s === 'commit') posseFim = performance.now();
      return original(sql);
    }) as unknown as typeof client.query;

    const r = await runBeforeSend(
      args(pool, {
        classifyPromiseSemantic: async () => {
          await new Promise((resolve) => setTimeout(resolve, CLASSIFICADOR_MS));
          return NAO_E_PROMESSA;
        },
      }),
    );

    expect(r.status).toBe('sent');
    expect(posseInicio).toBeGreaterThan(0);
    expect(posseFim - posseInicio).toBeLessThan(CLASSIFICADOR_MS);
  });

  it('julga o mesmo corpo que vai ao canal', async () => {
    const { pool } = poolFalso([]);
    let julgado = '';
    let enviado = '';
    await runBeforeSend(
      args(pool, {
        classifyPromiseSemantic: async (corpo: string) => {
          julgado = corpo;
          return NAO_E_PROMESSA;
        },
        send: async (corpo: string) => {
          enviado = corpo;
          return { kind: 'sent', idempotencyKey: 'k', messageId: 'm1' };
        },
      }),
    );
    expect(julgado).toBe('Consigo te dar 50% de desconto hoje.');
    expect(enviado).toBe(julgado);
  });

  it('o veto semântico real continua barrando: sem envio e com a transação desfeita', async () => {
    const eventos: Eventos = [];
    const { pool } = poolFalso(eventos);
    const envio = vi.fn(async () => ({ kind: 'sent' as const, idempotencyKey: 'k', messageId: 'm1' }));
    const r = await runBeforeSend(
      args(pool, {
        body: 'Pode deixar que eu faço de graça para você.',
        gates: [semanticPromiseGate],
        classifyPromiseSemantic: async () => ({
          ...NAO_E_PROMESSA,
          isPromise: true,
          suspectPhrase: 'faço de graça',
        }),
        send: envio,
      }),
    );
    expect(r.status).toBe('vetoed');
    expect(envio).not.toHaveBeenCalled();
    expect(eventos).toContain('rollback');
    expect(eventos).not.toContain('commit');
  });
});
