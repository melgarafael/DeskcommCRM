import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type pg from 'pg';
import type { ToolSet } from 'ai';
import { describe, expect, it, vi } from 'vitest';

import { emOrdemDeEscrita } from '@/lib/agent-engine/agent/fila-de-envio';
import {
  runBeforeSend,
  type RunBeforeSendArgs,
} from '@/lib/agent-engine/guardrails/before-send';
import type { Queryable } from '@/lib/agent-engine/queue/queue';
import type { CurrentServiceBoundary } from '@/lib/atendimento/fronteira';
import { guardServiceTools, withServiceBoundary } from '@/lib/atendimento/fronteira-server';

/**
 * A PERGUNTA DESTE ARQUIVO: quando o modelo chama `send_message` várias vezes no
 * MESMO passo, as mensagens chegam ao cliente na ordem em que ele as escreveu?
 *
 * O AI SDK inicia as chamadas de um passo na ordem do passo, mas as executa em
 * paralelo. Antes da fila, cada uma corria a cadeia `before_send` sozinha e
 * enviava quando ganhava o lock do número; a pausa humana do turno (uma só) caía
 * sobre a abertura, que saía por último. Medido em produção (v1.102.0,
 * 08/11/2026): "Boa pergunta! Pelo nome, acho que você quis dizer Enterprise"
 * chegou depois das outras duas mensagens da mesma resposta.
 *
 * As ferramentas aqui passam pelas MESMAS camadas do turno real, na mesma ordem:
 * `guardServiceTools` (posta por `runModelCall`) por fora de `emOrdemDeEscrita`
 * (posta por `inbound-turn.ts`), e o envio pelo `runBeforeSend` de verdade com
 * pool falso. A cerca no fim prende a costura ao `inbound-turn.ts`.
 *
 * O QUE ESTE ARQUIVO NÃO MEDE: um turno inteiro com o modelo de verdade e o lock
 * do Postgres sob contenção real.
 */

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

const fronteira: CurrentServiceBoundary = {
  organization_id: 'org',
  contact_id: 'contact',
  conversation_id: 'conversation',
  service_revision: 1,
  demanda_id: 'demand',
  demanda_revision: 1,
  status: 'open',
  demanda_fechada_em: null,
};

/** Banco da fronteira: cada consulta da guarda demora o que a lista mandar. */
function bancoDaFronteira(atrasosMs: number[]): Queryable {
  let i = 0;
  return {
    query: async () => {
      await dormir(atrasosMs[i++] ?? 0);
      return { rows: [fronteira] };
    },
  } as unknown as Queryable;
}

function poolFalso(): pg.Pool {
  const client = { query: vi.fn(async () => ({ rows: [] })), release: vi.fn() };
  return {
    connect: vi.fn(async () => client),
    query: vi.fn().mockResolvedValue({ rows: [{ id: 'trace-1' }] }),
  } as unknown as pg.Pool;
}

function argsDoEnvio(pool: pg.Pool, extras: Partial<RunBeforeSendArgs>): RunBeforeSendArgs {
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

/**
 * Um turno com o desenho do `inbound-turn.ts`: teto de envios conferido no começo
 * da chamada, cadeia com duração própria, pausa humana paga uma vez por turno
 * (por quem chega primeiro) e envio sob o lock do `runBeforeSend`.
 */
function turno(opcoes: { pausaMs?: number; cadeiaMs?: Record<string, number>; teto?: number } = {}) {
  const pool = poolFalso();
  const enviadas: string[] = [];
  let seq = 0;
  let jaEsperouComoHumano = false;
  const send_message = {
    inputSchema: {} as never,
    execute: async ({ body }: { body: string }) => {
      if (seq >= (opcoes.teto ?? 10)) return { ok: false, error: { code: 'turn_send_limit' } };
      await dormir(opcoes.cadeiaMs?.[body] ?? 0);
      const r = await runBeforeSend(
        argsDoEnvio(pool, {
          body,
          esperaForaDoLock: async () => {
            if (jaEsperouComoHumano) return;
            jaEsperouComoHumano = true;
            await dormir(opcoes.pausaMs ?? 0);
          },
          send: async (finalBody) => {
            seq += 1;
            enviadas.push(finalBody);
            return { kind: 'sent', idempotencyKey: finalBody, messageId: finalBody };
          },
        }),
      );
      return { ok: r.status === 'sent' };
    },
  };
  return { tools: { send_message } as unknown as ToolSet, enviadas };
}

/** O que o AI SDK faz com as chamadas de um passo: inicia todas, na ordem, e espera. */
function passo(tools: ToolSet | undefined, corpos: string[]) {
  const execute = tools?.send_message?.execute;
  if (!execute) throw new Error('send_message sem execute');
  return Promise.all(corpos.map((body) => execute({ body }, {} as never)));
}

describe('as mensagens de um passo saem na ordem em que o modelo as escreveu', () => {
  it('a abertura paga a pausa humana e ainda assim sai primeiro (o caso de produção)', async () => {
    const { tools, enviadas } = turno({ pausaMs: 40 });
    const corpos = [
      'Boa pergunta! Pelo nome, acho que você quis dizer Enterprise',
      'Mas pra 10.000 fotos/mês o Enterprise não compensa',
      'No seu volume, o Pro semestral é o que entrega mais',
    ];
    await passo(emOrdemDeEscrita(tools), corpos);
    expect(enviadas).toEqual(corpos);
  });

  it('a cadeia mais lenta na primeira chamada não inverte a ordem', async () => {
    const { tools, enviadas } = turno({ cadeiaMs: { '1': 30, '2': 0, '3': 10 } });
    await passo(emOrdemDeEscrita(tools), ['1', '2', '3']);
    expect(enviadas).toEqual(['1', '2', '3']);
  });

  it('a guarda do atendimento mais lenta na primeira chamada não inverte a ordem', async () => {
    const { tools, enviadas } = turno();
    // 1ª consulta: a de `withServiceBoundary`; depois, uma por chamada.
    const db = bancoDaFronteira([0, 40, 0, 10]);
    await withServiceBoundary(db, fronteira, () =>
      passo(guardServiceTools(emOrdemDeEscrita(tools)), ['1', '2', '3']),
    );
    expect(enviadas).toEqual(['1', '2', '3']);
  });

  it('o teto de envios do turno vale para chamadas paralelas', async () => {
    const { tools, enviadas } = turno({ teto: 2, cadeiaMs: { a: 10 } });
    const r = await passo(emOrdemDeEscrita(tools), ['a', 'b', 'c']);
    expect(enviadas).toEqual(['a', 'b']);
    expect(r[2]).toMatchObject({ ok: false, error: { code: 'turn_send_limit' } });
  });

  it('a chamada que falha libera a vez: a seguinte envia', async () => {
    const enviadas: string[] = [];
    const tools = emOrdemDeEscrita({
      send_message: {
        inputSchema: {} as never,
        execute: async ({ body }: { body: string }) => {
          await dormir(5);
          if (body === 'quebra') throw new Error('veto');
          enviadas.push(body);
          return { ok: true };
        },
      },
    } as unknown as ToolSet);
    const execute = tools.send_message!.execute!;
    const [a, b] = [execute({ body: 'quebra' }, {} as never), execute({ body: 'segue' }, {} as never)];
    await expect(a).rejects.toThrow('veto');
    await expect(b).resolves.toEqual({ ok: true });
    expect(enviadas).toEqual(['segue']);
  });

  it('ferramenta que não fala com o cliente fica fora da fila', () => {
    const lerContexto = { inputSchema: {} as never, execute: async () => ({}) };
    const tools = emOrdemDeEscrita({ get_lead_context: lerContexto } as unknown as ToolSet);
    expect(tools.get_lead_context).toBe(lerContexto);
  });
});

describe('cerca: o turno põe as ferramentas na fila por fora de todas as camadas', () => {
  it('`emOrdemDeEscrita` embrulha o conjunto final de ferramentas do turno', () => {
    const fonte = readFileSync(join(process.cwd(), 'lib/agent-engine/agent/inbound-turn.ts'), 'utf8');
    expect(fonte).toMatch(/const tools = emOrdemDeEscrita\(\s*envolverFerramentasComTraco\(/);
  });
});
