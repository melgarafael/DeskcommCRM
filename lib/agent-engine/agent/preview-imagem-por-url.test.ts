import { DEFAULT_CHANNEL_PROVIDER } from '@/lib/channels';
import { describe, it, expect, vi } from 'vitest';
import { tool } from '../edge/llm/run-model-call';
import { z } from 'zod';
import { applyPreviewPolicy, newPreviewResult, scenarioContext, type TurnPreview } from './preview';
import { evaluateBeforeSend, type GateContext } from '../guardrails/before-send';
import { PACING_DEFAULTS } from '../pacing/defaults';
import { SPINNING_DEFAULTS } from '../spinning/defaults';

// A prévia não faz rede: a guarda anti-SSRF (C6) não pode ser chamada aqui.
const mocks = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup, default: { lookup: mocks.lookup } }));

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

describe('prévia de send_message com imagem_url — nada é buscado nem enviado', () => {
  it('URL com formato aceito: o retorno diz que a foto sairia, sem chamar o canal nem a guarda de rede', async () => {
    mocks.lookup.mockReset();
    const send = vi.fn(),
      p = preview();
    const tools = applyPreviewPolicy({ send_message: definition(send) }, p, gate(), () => []);
    const r = await execute(tools, 'send_message', {
      body: 'Olá, posso ajudar?',
      imagem_url: 'https://exemplo.test/receitas/casa-1.jpg',
    });
    expect(send).not.toHaveBeenCalled();
    expect(mocks.lookup).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, foto_enviada: false, foto_prevista: 'formato_aceito' });
    expect(p.result.candidates).toHaveLength(1);
  });

  it('URL com extensão recusada: a prévia avisa que o texto sairia sem foto', async () => {
    const p = preview();
    const tools = applyPreviewPolicy({ send_message: definition(vi.fn()) }, p, gate(), () => []);
    const r = await execute(tools, 'send_message', {
      body: 'Olá, posso ajudar?',
      imagem_url: 'https://exemplo.test/receitas/casa-1.gif',
    });
    expect(r).toMatchObject({ ok: true, foto_enviada: false, foto_prevista: 'recusada_pelo_formato: extensao_nao_aceita' });
    expect(p.result.warnings.map((w) => w.code)).toContain('imagem_recusada');
  });

  it('imagem_url junto com produto_codigo: erro instrutivo na prévia, nada proposto', async () => {
    const p = preview();
    const send = vi.fn();
    const tools = applyPreviewPolicy({ send_message: definition(send) }, p, gate(), () => []);
    const r = await execute(tools, 'send_message', {
      body: 'Olá, posso ajudar?',
      imagem_url: 'https://exemplo.test/receitas/casa-1.jpg',
      produto_codigo: 'IP15',
    });
    expect(r).toMatchObject({ ok: false, error: { code: 'imagem_e_produto_juntos' } });
    expect(p.result.candidates).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
  });
});
