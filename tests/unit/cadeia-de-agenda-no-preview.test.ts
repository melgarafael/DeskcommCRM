import { describe, expect, it, vi } from 'vitest';

import { z } from 'zod';
import { tool } from '@/lib/agent-engine/edge/llm/run-model-call';
import { DEFAULT_CHANNEL_PROVIDER } from '@/lib/channels';
import {
  applyPreviewPolicy,
  newPreviewResult,
  scenarioContext,
  type TurnPreview,
} from '@/lib/agent-engine/agent/preview';
import {
  ferramentasDeAgendaDoAgente,
  temFerramentaDeAgenda,
} from '@/lib/agent-engine/agent/inbound-turn';
import type { GateContext } from '@/lib/agent-engine/guardrails/before-send';
import { PACING_DEFAULTS } from '@/lib/agent-engine/pacing/defaults';
import { SPINNING_DEFAULTS } from '@/lib/agent-engine/spinning/defaults';

/** O agente do relato #1019: as três capacidades de agenda ligadas. */
const LIST = 'crm_list_event_types';
const FIND = 'crm_find_free_slots';
const BOOK = 'crm_book_appointment';
const TRES = [LIST, FIND, BOOK];

const gate = (): GateContext => ({
  now: new Date('2026-09-16T19:00:00Z'),
  body: 'Olá, posso ajudar?',
  optedOut: false,
  provider: DEFAULT_CHANNEL_PROVIDER,
  messagingWindow: { lastInboundAt: new Date('2026-09-16T18:00:00Z') },
  pacing: {
    knobs: PACING_DEFAULTS,
    state: { lastSentAt: null, sentToday: 0, numberActivatedAt: null },
    crmDailyLimit: null,
  },
  spinning: { knobs: SPINNING_DEFAULTS, window: [] },
  promise: { table: null },
  semanticPromise: null,
  disclosure: { template: null, isFirstOutbound: false, mode: 'inject' },
  lgpd: null,
  casesEnabled: false,
  hasOpenCase: false,
  openedCaseThisTurn: false,
});

const preview = (): TurnPreview =>
  ({
    kind: 'sandbox',
    organizationId: 'real-org',
    runId: 'preview-run',
    contactId: null,
    channelId: null,
    agent: { toolIds: TRES } as TurnPreview['agent'],
    context: scenarioContext([
      { direction: 'inbound', body: 'Que horário vocês têm para limpeza?', sent_at: '2026-09-16T19:00:00Z' },
    ]),
    result: newPreviewResult(),
  }) as TurnPreview;

const definition = (execute: (args: Record<string, unknown>) => unknown) =>
  tool({
    inputSchema: z.record(z.string(), z.unknown()),
    execute: async (args) => execute(args as Record<string, unknown>),
  });

async function exec(
  t: ReturnType<typeof applyPreviewPolicy>,
  name: string,
  args: Record<string, unknown> = {},
) {
  return t[name]!.execute!(args, { toolCallId: 'test', messages: [], context: undefined });
}

describe('a cadeia de agenda na prévia (#1019)', () => {
  it('lista -> horários -> marca: o slug do primeiro passo vira argumento do segundo', async () => {
    const p = preview();
    let chamouHorarios = false;
    const ctx = {
      ...gate(),
      agenda: {
        active: temFerramentaDeAgenda(TRES),
        ferramentas: ferramentasDeAgendaDoAgente(TRES),
        toolCalledThisTurn: false,
      },
    };
    const tools = applyPreviewPolicy(
      {
        [LIST]: definition(() => ({ ok: true, tipos: [{ slug: 'limpeza', nome: 'Limpeza' }] })),
        [FIND]: definition((args) => {
          chamouHorarios = true;
          return { ok: true, horarios: [{ inicio: '2026-09-22T14:00:00Z', quando: 'terça às 14h' }], recebido: args.event_type_slug };
        }),
        [BOOK]: definition(() => ({ ok: true, compromisso: { id: 'ap-1' } })),
        send_message: definition(vi.fn()),
      },
      p,
      ctx,
      () => [],
      undefined,
      () => ({ agenda: { active: true, ferramentas: ferramentasDeAgendaDoAgente(TRES), toolCalledThisTurn: chamouHorarios } }),
    );

    const lista = (await exec(tools, LIST)) as { tipos: Array<{ slug: string }> };
    expect(lista.tipos[0]?.slug).toBe('limpeza');

    await exec(tools, 'send_message', { body: 'Vou verificar o horário para você.' });
    expect(p.result.impediments.some((i) => i.code === 'agenda_stall_sem_ferramenta')).toBe(true);

    const slots = (await exec(tools, FIND, { event_type_slug: lista.tipos[0]!.slug })) as {
      ok: boolean;
      recebido: string;
    };
    expect(chamouHorarios).toBe(true);
    expect(slots.recebido).toBe('limpeza');

    await exec(tools, 'send_message', { body: 'Terça às 14h está livre, posso marcar?' });
    expect(p.result.candidates).toHaveLength(1);

    await exec(tools, BOOK, { event_type_slug: 'limpeza', starts_at: '2026-09-22T14:00:00Z' });
    expect(p.result.proposals.some((x) => x.tool === BOOK)).toBe(true);
  });
});
