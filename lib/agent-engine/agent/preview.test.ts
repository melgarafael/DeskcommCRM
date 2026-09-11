import { DEFAULT_CHANNEL_PROVIDER } from '@/lib/channels';
import { describe, it, expect, vi } from 'vitest';
import { tool } from '../edge/llm/run-model-call';
import { z } from 'zod';
import { applyPreviewPolicy, newPreviewResult, scenarioContext, type TurnPreview } from './preview';
import { evaluateBeforeSend, type GateContext } from '../guardrails/before-send';
import { PACING_DEFAULTS } from '../pacing/defaults';
import { SPINNING_DEFAULTS } from '../spinning/defaults';
const gate = (): GateContext => ({
  now: new Date('2026-09-07T15:00:00Z'),
  body: 'Olá, posso ajudar?',
  optedOut: false,
  provider: DEFAULT_CHANNEL_PROVIDER,
  messagingWindow: { lastInboundAt: new Date('2026-09-07T14:00:00Z') },
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
const preview = () =>
  ({
    kind: 'sandbox',
    organizationId: 'real-org',
    runId: 'preview-run',
    contactId: null,
    channelId: null,
    agent: {},
    context: scenarioContext([]),
    result: newPreviewResult(),
  }) as TurnPreview;
const definition = (execute: (args: unknown) => unknown) =>
  tool({
    inputSchema: z.object({ body: z.string().optional() }),
    execute: async (args) => execute(args),
  });
async function execute(t: ReturnType<typeof applyPreviewPolicy>, name: string, args: unknown = {}) {
  return t[name]!.execute!(args, { toolCallId: 'test', messages: [], context: undefined });
}
describe('preview policy shares gates and contains side effects', () => {
  it('registers text and mutation proposals without calling either operational executor', async () => {
    const send = vi.fn(),
      write = vi.fn(),
      p = preview();
    const tools = applyPreviewPolicy(
      { send_message: definition(send), update_lead_state: definition(write) },
      p,
      gate(),
      () => [],
    );
    await execute(tools, 'update_lead_state', { stage: 'qualified' });
    await execute(tools, 'send_message', { body: 'Olá, posso ajudar?' });
    expect(send).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(p.result.proposals).toHaveLength(1);
    expect(p.result.candidates[0]?.body).toBe('Olá, posso ajudar?');
  });
  it('uses exactly the real opt-out decision and prevents a simulated candidate too', async () => {
    const p = preview(),
      ctx = { ...gate(), optedOut: true },
      spy = vi.fn();
    const tools = applyPreviewPolicy({ send_message: definition(spy) }, p, ctx, () => []);
    await execute(tools, 'send_message', { body: ctx.body });
    expect(p.result.candidates).toEqual([]);
    expect(p.result.impediments[0]?.code).toBe(evaluateBeforeSend(ctx).veto?.code);
    expect(spy).not.toHaveBeenCalled();
  });
  it('keeps knowledge reads real and preserves independently generated citations', async () => {
    const read = vi.fn(async () => ({
        ok: true,
        results: [{ content: 'Conhecimento autorizado' }],
      })),
      p = preview();
    const tools = applyPreviewPolicy(
      { search_knowledge: definition(read), send_message: definition(vi.fn()) },
      p,
      gate(),
      () => [],
    );
    await execute(tools, 'search_knowledge');
    await execute(tools, 'send_message', { body: 'Conhecimento autorizado' });
    expect(read).toHaveBeenCalledOnce();
    expect(p.result.candidates).toHaveLength(1);
  });
  it('fails closed for unknown capability and never invokes it', async () => {
    const p = preview(),
      spy = vi.fn();
    const tools = applyPreviewPolicy({ hidden_mutation: definition(spy) }, p, gate(), () => []);
    await execute(tools, 'hidden_mutation');
    expect(spy).not.toHaveBeenCalled();
    expect(p.result.impediments[0]?.code).toBe('unknown_preview_tool');
  });
  it('does not mutate the original gate context when disclosure amends a body', () => {
    const ctx = {
      ...gate(),
      disclosure: {
        template: 'Sou assistente virtual.',
        isFirstOutbound: true,
        mode: 'inject' as const,
      },
    };
    const before = structuredClone(ctx);
    const result = evaluateBeforeSend(ctx);
    expect(ctx).toEqual(before);
    expect(result.trace.length).toBeGreaterThan(1);
  });
});

it('refreshes agenda read state for each candidate while writes stay proposals', async () => {
  const p = preview();
  p.contactId = 'actual-contact';
  let called = false;
  const ctx = { ...gate(), agenda: { active: true, toolCalledThisTurn: false } };
  const tools = applyPreviewPolicy(
    {
      crm_find_free_slots: definition(() => {
        called = true;
        return { ok: true, slots: [] };
      }),
      send_message: definition(vi.fn()),
    },
    p,
    ctx,
    () => [],
    undefined,
    () => ({ agenda: { active: true, toolCalledThisTurn: called } }),
  );
  await execute(tools, 'send_message', { body: 'Vou verificar o horário para você.' });
  expect(p.result.impediments.some((i) => i.code === 'agenda_stall_sem_ferramenta')).toBe(true);
  await execute(tools, 'crm_find_free_slots');
  await execute(tools, 'send_message', { body: 'Vou verificar o horário para você.' });
  expect(p.result.candidates).toHaveLength(1);
});

it('consulta a grade real no cenário e só libera o horário depois da execução', async () => {
  const p = preview();
  let called = false;
  const ctx = {
    ...gate(),
    academiaGrade: { active: true, toolCalledThisTurn: false },
  };
  const tools = applyPreviewPolicy(
    {
      crm_find_academia_classes: definition(() => {
        called = true;
        return { ok: true, aulas: [{ modalidade: 'CrossFit', inicio: '08:00' }] };
      }),
      send_message: definition(vi.fn()),
    },
    p,
    ctx,
    () => [],
    undefined,
    () => ({
      academiaGrade: { active: true, toolCalledThisTurn: called },
    }),
  );

  await execute(tools, 'send_message', { body: 'O CrossFit de segunda-feira é às 08:00.' });
  expect(p.result.impediments.some((i) => i.code === 'academia_grade_stall_sem_ferramenta')).toBe(
    true,
  );

  await execute(tools, 'crm_find_academia_classes', { modalidade: 'CrossFit', dia_semana: 1 });
  expect(called).toBe(true);
  await execute(tools, 'send_message', { body: 'O CrossFit de segunda-feira é às 08:00.' });
  expect(p.result.candidates).toHaveLength(1);
});

it('uses only supplied in-memory sample contact in sandbox', () => {
  const context = scenarioContext([], { name: 'Maria Cenário', phone: '+5511999999999' });
  expect(context.context.contact.name).toBe('Maria Cenário');
  expect(context.context.contact.phone).toBe('+5511999999999');
});
