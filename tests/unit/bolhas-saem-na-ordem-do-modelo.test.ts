import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { criarFilaDeEnvio, type VezNaFila } from '@/lib/agent-engine/agent/fila-de-envio';
import {
  runBeforeSend,
  type RunBeforeSendArgs,
} from '@/lib/agent-engine/guardrails/before-send';

/**
 * A PERGUNTA DESTE ARQUIVO: quando o modelo chama `send_message` várias vezes no
 * MESMO passo, as bolhas chegam ao cliente na ordem em que ele as escreveu?
 *
 * O AI SDK executa as chamadas de um passo em paralelo. Cada uma passa pela
 * cadeia `before_send` e só envia com o lock do número na mão; a pausa humana do
 * turno é paga uma vez só, por quem chega primeiro — em geral a abertura. Antes
 * da fila, a abertura ficava presa na pausa enquanto as outras tomavam o lock e
 * saíam na frente. Medido em produção (v1.102.0, 08/11/2026): a bolha "Boa
 * pergunta! Pelo nome, acho que você quis dizer Enterprise" chegou por último.
 *
 * Os casos de comportamento usam o `runBeforeSend` de verdade (pool falso, como
 * em `espera-humana-fora-do-lock-do-numero.test.ts`) e reproduzem o gancho
 * `esperaForaDoLock` do turno: espera a vez, depois a pausa uma vez por turno.
 * A cerca no fim prende essa costura ao `inbound-turn.ts`.
 *
 * O QUE ESTE ARQUIVO NÃO MEDE: um turno inteiro com o modelo de verdade e o lock
 * do Postgres sob contenção real.
 */

function poolFalso() {
  const client = { query: vi.fn(async () => ({ rows: [] })), release: vi.fn() };
  const pool = {
    connect: vi.fn(async () => client),
    query: vi.fn().mockResolvedValue({ rows: [{ id: 'trace-1' }] }),
  };
  return pool as unknown as pg.Pool;
}

function args(pool: pg.Pool, extras: Partial<RunBeforeSendArgs>): RunBeforeSendArgs {
  return {
    pool,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    tenantId: '00000000-0000-4000-8000-000000000001',
    leadId: '00000000-0000-4000-8000-000000000002',
    jobId: '00000000-0000-4000-8000-000000000003',
    channelSessionId: '00000000-0000-4000-8000-000000000004',
    body: 'x',
    optedOutThisTurn: false,
    crmDailyLimit: null,
    now: new Date('2026-11-08T21:13:00.000Z'),
    rng: () => 0,
    sleep: async () => {},
    gates: [],
    send: async () => ({ kind: 'sent', idempotencyKey: 'k', messageId: 'm' }),
    ...extras,
  };
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Um turno com o mesmo desenho do `inbound-turn.ts`: fila + pausa uma vez por turno. */
function turno(pausaMs: number) {
  const pool = poolFalso();
  const emOrdemDeEscrita = criarFilaDeEnvio();
  let jaEsperouComoHumano = false;
  const enviadas: string[] = [];
  const sendMessage = (body: string, cadeiaMs = 0) =>
    emOrdemDeEscrita({ body }, async ({ body: b }, vez: VezNaFila) => {
      await dormir(cadeiaMs); // consultas da cadeia antes do lock (rodam em paralelo)
      return runBeforeSend(
        args(pool, {
          body: b,
          esperaForaDoLock: async () => {
            await vez.anterior;
            if (jaEsperouComoHumano) return;
            jaEsperouComoHumano = true;
            await dormir(pausaMs);
          },
          send: async (finalBody) => {
            enviadas.push(finalBody);
            return { kind: 'sent', idempotencyKey: finalBody, messageId: finalBody };
          },
        }),
      );
    });
  return { sendMessage, enviadas };
}

describe('as bolhas de um passo saem na ordem em que o modelo as escreveu', () => {
  it('a abertura paga a pausa humana e ainda assim sai primeiro (o caso de produção)', async () => {
    const { sendMessage, enviadas } = turno(40);
    const r = await Promise.all([
      sendMessage('Boa pergunta! Pelo nome, acho que você quis dizer Enterprise'),
      sendMessage('Mas pra 10.000 fotos/mês o Enterprise não compensa'),
      sendMessage('No seu volume, o Pro semestral é o que entrega mais'),
    ]);
    expect(r.map((x) => x.status)).toEqual(['sent', 'sent', 'sent']);
    expect(enviadas).toEqual([
      'Boa pergunta! Pelo nome, acho que você quis dizer Enterprise',
      'Mas pra 10.000 fotos/mês o Enterprise não compensa',
      'No seu volume, o Pro semestral é o que entrega mais',
    ]);
  });

  it('a cadeia mais lenta na primeira chamada não inverte a ordem', async () => {
    const { sendMessage, enviadas } = turno(0);
    await Promise.all([sendMessage('1', 30), sendMessage('2', 0), sendMessage('3', 10)]);
    expect(enviadas).toEqual(['1', '2', '3']);
  });

  it('a chamada que falha libera a vez: a seguinte envia', async () => {
    const fila = criarFilaDeEnvio();
    const ordem: string[] = [];
    const primeira = fila(null, async () => {
      await dormir(10);
      throw new Error('veto');
    });
    const segunda = fila(null, async (_a, vez) => {
      await vez.anterior;
      ordem.push('segunda');
      return 'ok';
    });
    await expect(primeira).rejects.toThrow('veto');
    await expect(segunda).resolves.toBe('ok');
    expect(ordem).toEqual(['segunda']);
  });
});

describe('cerca: o turno usa a fila no send_message', () => {
  const fonte = readFileSync(
    join(process.cwd(), 'lib/agent-engine/agent/inbound-turn.ts'),
    'utf8',
  );

  it('o execute do send_message entra na fila antes de qualquer await', () => {
    expect(fonte).toMatch(/execute: \(entrada\) => emOrdemDeEscrita\(entrada, async \(/);
  });

  it('o gancho da pausa espera a vez ANTES de decidir se paga a pausa', () => {
    const i = fonte.indexOf('esperaForaDoLock: async (): Promise<void> => {');
    expect(i).toBeGreaterThan(0);
    const trecho = fonte.slice(i, fonte.indexOf('pararDigitando();', i));
    const espera = trecho.indexOf('await vez.anterior;');
    expect(espera).toBeGreaterThan(0);
    expect(espera).toBeLessThan(trecho.indexOf('if (jaEsperouComoHumano) return;'));
  });
});
