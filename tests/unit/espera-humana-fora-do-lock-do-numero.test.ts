import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';

import {
  runBeforeSend,
  type RunBeforeSendArgs,
} from '@/lib/agent-engine/guardrails/before-send';

/**
 * A PERGUNTA DESTE ARQUIVO (issue #654): ONDE a pausa humana do turno é paga?
 *
 * `runBeforeSend` é o dono da posse do lock do NÚMERO: ele toma conexão do pool,
 * abre transação, `select pg_advisory_xact_lock(hashtext(channelSessionId))`,
 * carrega o estado, julga a cadeia, envia e só então commita. Enquanto essa
 * transação está aberta, dois workers escrevendo no MESMO WhatsApp ficam em fila —
 * é exatamente para isso que o lock existe.
 *
 * A pausa humana ("digitando…", 1.2s–7.5s) morava DO LADO DE DENTRO desse caminho:
 * no `antesDaPrimeira` do `sendInBubbles`, que roda dentro do callback `send`, isto é,
 * já com o lock na mão. Resultado: cada turno segurava a fila do NÚMERO por até 7.5s
 * a mais; com o throttle anti-ban (0–2s, que dorme no mesmo ponto) o pior caso
 * somava até 9.5s.
 *
 * O invariante que este arquivo prende é de POSIÇÃO — por isso ele é medível sem
 * medir contenção real:
 *   a) a espera roda ANTES de o guardrail tomar conexão: quando ela acontece, não
 *      existe transação aberta nem lock em posse (nada de `connect`/`begin`/lock);
 *   b) os dois intervalos não se sobrepõem — a posse (`begin`→`commit`) fica MENOR
 *      que a própria espera, porque a espera acabou antes de a transação abrir.
 *
 * O QUE ESTE ARQUIVO NÃO MEDE (declarado no PR como não-medido): a contenção real de
 * dois atendimentos no mesmo número sob carga — isso precisa de Postgres de verdade,
 * e não há Docker nesta máquina; quem prova esse lado é o job de integração do CI.
 *
 * POR QUE ELE NASCE VERMELHO: o gancho `esperaForaDoLock` é a única coisa que paga a
 * espera fora do lock. Sem a linha que o chama dentro de `runBeforeSend`, o mock da
 * espera nunca é chamado e a primeira asserção falha — foi assim que a falha foi
 * medida antes do conserto (`pnpm vitest run tests/unit/espera-humana-fora-do-lock-do-numero.test.ts`).
 */

type Eventos = string[];

/** Relógio monotônico: em `Date.now()` os ms empatam e a ordem (o contrato aqui) se perde. */
const relogio = (): number => performance.now();

/** Pool fake: registra a ORDEM dos eventos do guardrail. */
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
  return { pool: pool as unknown as pg.Pool, client, cru: pool };
}

function argsDoTurno(
  pool: pg.Pool,
  extras: Partial<RunBeforeSendArgs> = {},
): RunBeforeSendArgs {
  return {
    pool,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    tenantId: '00000000-0000-4000-8000-000000000001',
    leadId: '00000000-0000-4000-8000-000000000002',
    jobId: '00000000-0000-4000-8000-000000000003',
    channelSessionId: '00000000-0000-4000-8000-000000000004',
    body: 'Olá! Segue o orçamento que você pediu.',
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

describe('a pausa humana é paga FORA da posse do lock do número (#654)', () => {
  it('a espera roda antes de o guardrail tomar conexão — nenhuma transação aberta', async () => {
    const eventos: Eventos = [];
    const { pool } = poolFalso(eventos);
    const espera = vi.fn(async () => {});

    const r = await runBeforeSend(
      argsDoTurno(pool, {
        esperaForaDoLock: espera,
        send: async () => {
          eventos.push('send');
          return { kind: 'sent', idempotencyKey: 'k', messageId: 'm1' };
        },
      }),
    );

    expect(r.status).toBe('sent');
    // O contrato do conserto: a espera existe, é paga uma vez por turno...
    expect(espera).toHaveBeenCalledTimes(1);
    // ...e é paga ANTES de qualquer contato com o banco. Sem isso ela volta a
    // acontecer com a transação aberta e o número fica em fila durante a pausa.
    expect(eventos[0]).toBe('connect');
    expect(eventos).toEqual(['connect', 'begin', 'lock', 'send', 'commit']);
  });

  it('a janela begin→commit não contém a espera: a posse fica menor que a pausa', async () => {
    const eventos: Eventos = [];
    const { pool, client, cru } = poolFalso(eventos);
    const ESPERA_MS = 40;
    let posseInicio = 0;
    let posseFim = 0;
    let esperaTerminouEm = 0;

    const original = client.query;
    client.query = vi.fn(async (sql: string) => {
      const s = String(sql).toLowerCase().trim();
      if (s === 'begin') posseInicio = relogio();
      if (s === 'commit') posseFim = relogio();
      return original(sql);
    }) as unknown as typeof client.query;
    const conectado = cru.connect;

    const r = await runBeforeSend(
      argsDoTurno(pool, {
        esperaForaDoLock: async () => {
          // Espera de verdade, curta: é o tempo que ANTES ficava em cima do lock.
          await new Promise((resolve) => setTimeout(resolve, ESPERA_MS));
          esperaTerminouEm = relogio();
        },
        send: async () => ({ kind: 'sent', idempotencyKey: 'k', messageId: 'm2' }),
      }),
    );

    expect(r.status).toBe('sent');
    expect(esperaTerminouEm).toBeGreaterThan(0);
    expect(conectado).toHaveBeenCalledTimes(1);
    expect(posseInicio).toBeGreaterThan(0);
    expect(posseFim).toBeGreaterThan(0);
    // Os dois intervalos não se sobrepõem: a espera terminou antes de a transação abrir.
    // (`<=` porque o relógio monotônico pode empatar no mesmo tick — o que o contrato
    // proíbe é a espera terminar DEPOIS de a posse começar.)
    expect(esperaTerminouEm).toBeLessThanOrEqual(posseInicio);
    expect(posseFim - posseInicio).toBeLessThan(ESPERA_MS);
  });

  it('sem o gancho, nada muda para os outros chamadores do guardrail', async () => {
    // Os outros call sites (marcação por regra, cadência/heartbeat, fecho de
    // handoff, retomada) não têm pausa humana: gancho ausente = sem pausa, e o envio
    // sai pelo caminho de sempre, já com a posse do lock — que é o desenho deles.
    const eventos: Eventos = [];
    const { pool } = poolFalso(eventos);

    const r = await runBeforeSend(
      argsDoTurno(pool, {
        send: async () => {
          eventos.push('send');
          return { kind: 'sent', idempotencyKey: 'k', messageId: 'm3' };
        },
      }),
    );

    expect(r.status).toBe('sent');
    expect(eventos).toEqual(['connect', 'begin', 'lock', 'send', 'commit']);
  });
});
