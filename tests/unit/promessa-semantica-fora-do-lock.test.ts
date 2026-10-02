import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';

import {
  runBeforeSend,
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
  return { pool: pool as unknown as pg.Pool, cru: pool };
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

const NAO_E_PROMESSA: PromiseClassification = { isPromise: false, suspectPhrase: null };

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
    expect(vistos).toEqual([{ isPromise: true, suspectPhrase: '50% de desconto' }]);
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
