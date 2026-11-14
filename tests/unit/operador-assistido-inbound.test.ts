/**
 * MODO ASSISTIDO — o inbound_turn que só gera rascunho também enfileira o Operador
 * (recorte do #3915, de @felipehenriquess).
 *
 * Antes: o agente em modo assistido saía do handler sem `operator_turn`, e o funil parava.
 *
 * O que estes casos travam:
 *   - o rascunho continua saindo E o `operator_turn` é enfileirado depois dele, com o
 *     mesmo agente que gerou o rascunho;
 *   - papel do Operador desligado → nada é enfileirado;
 *   - gate de elegibilidade fechado → nada é enfileirado (o turno nem começou);
 *   - falha ao enfileirar nunca derruba o turno.
 *
 * Harness de mocks: o de `assistido-respeita-o-gate.test.ts`, mudando só a variável em teste.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublishedAgentConfig } from '@/lib/agent-engine/agent/agent-config';

const mocks = vi.hoisted(() => ({
  router: vi.fn(), classify: vi.fn(), byId: vi.fn(), bySession: vi.fn(),
  draft: vi.fn(), operation: vi.fn(), handoff: vi.fn(), elegibilidade: vi.fn(), enqueue: vi.fn(),
}));
vi.mock('@/lib/agent-engine/agent/router-config', () => ({ loadActiveRouter: mocks.router }));
vi.mock('@/lib/agent-engine/agent/intent-classifier', () => ({ classifyIntent: mocks.classify }));
vi.mock('@/lib/agent-engine/agent/agent-config', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  loadPublishedAgentConfigById: mocks.byId, loadPublishedAgentConfig: mocks.bySession,
  escolherAgenteDoNumero: async (...a: unknown[]) => ({ config: await (mocks.bySession as (...x: unknown[]) => unknown)(...a), motivo: 'primeiro_da_fila' }),
}));
vi.mock('@/lib/agent-engine/agent/reply-drafts', () => ({ generateReplyDraft: mocks.draft }));
vi.mock('@/lib/atendimento/fronteira-server', () => ({
  currentExecutionBoundary: () => undefined, setExecutionAgentOperation: mocks.operation,
  guardServiceEffect: vi.fn(),
}));
vi.mock('@/lib/agent-engine/agent/human-handoff', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(), isLeadInHandoff: mocks.handoff,
}));
vi.mock('@/lib/agent-engine/queue/queue', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(), enqueueJob: mocks.enqueue,
}));
vi.mock('@/lib/escalacao/assunto-comercial', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(), comercialExigeHumano: vi.fn(async () => false),
}));
vi.mock('@/lib/agent-engine/guardrails/camadas-da-org', () => ({
  lerCamadasDaOrg: vi.fn(async () => ({})), camadaLigada: vi.fn(() => false),
}));
vi.mock('@/lib/agent-engine/agent/fuso-da-org', () => ({ fusoDaOrganizacao: vi.fn(async () => 'UTC') }));
vi.mock('@/lib/ai/elegibilidade/consulta-pg', () => ({ decidirElegibilidadeDaConversa: mocks.elegibilidade }));
vi.mock('@/lib/agent-engine/pacing/store', () => ({ loadChannelKnobs: vi.fn(async () => ({ knobs: {} })) }));
vi.mock('@/lib/agent-engine/pacing/engine', () => ({ janelaDeEnvioAberta: () => true, proximaAberturaDaJanela: vi.fn() }));
vi.mock('@/lib/agent-engine/pacing/aviso-de-janela', () => ({
  resolverAvisoDeJanela: vi.fn(async () => 0), avisarJanelaFechada: vi.fn(),
}));

import { createInboundTurnHandler, type InboundTurnDeps } from '@/lib/agent-engine/agent/inbound-turn';

const ids = {
  org: '11000000-0000-4000-8000-000000000001', contact: '11000000-0000-4000-8000-000000000002',
  conversation: '11000000-0000-4000-8000-000000000003', channel: '11000000-0000-4000-8000-000000000004',
  job: '11000000-0000-4000-8000-000000000005',
};
const job = {
  id: ids.job, organization_id: ids.org, contact_id: ids.contact, kind: 'inbound_turn',
  payload: { conversation_id: ids.conversation, contact_id: ids.contact, channel_session_id: ids.channel,
    inbound_message_id: '11000000-0000-4000-8000-000000000006', crm_event_id: '11000000-0000-4000-8000-000000000007' },
};
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const deps = { log, llmCfg: {}, crmCfg: {}, knobs: {} } as unknown as InboundTurnDeps;

const agente = (extra: Partial<PublishedAgentConfig> = {}): PublishedAgentConfig =>
  ({
    agentId: 'agente-1', versionId: 'version-1', operationRevision: '7', operationMode: 'assisted',
    pausedAt: null, handoffKeywords: [] as string[], operatorEnabled: true, ...extra,
  }) as PublishedAgentConfig;

function pool(a: PublishedAgentConfig | null) {
  mocks.router.mockResolvedValue(null);
  mocks.byId.mockResolvedValue(a);
  mocks.bySession.mockResolvedValue(a);
  return { query: vi.fn(async () => ({ rows: [{ active_ai_agent_id: null, active_intent: null, body: 'oi' }] })) };
}

const rodar = (p: unknown) => createInboundTurnHandler(deps)(job as never, p as never, { workerId: 'worker' });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.handoff.mockResolvedValue(false);
  mocks.elegibilidade.mockResolvedValue({ permite: true, motivo: 'gate_aberto' });
  mocks.enqueue.mockResolvedValue({ job: { id: 'op-1' }, deduped: false });
});

describe('agente em modo assistido', () => {
  it('o rascunho SAI como antes E o operator_turn é enfileirado', async () => {
    const a = agente({ operationMode: 'assisted' });
    await rodar(pool(a));

    expect(mocks.draft).toHaveBeenCalledOnce();
    expect(mocks.enqueue).toHaveBeenCalledOnce();
    const [, org, entrada] = mocks.enqueue.mock.calls[0]!;
    expect(org).toBe(ids.org);
    expect(entrada).toMatchObject({
      kind: 'operator_turn',
      leadId: ids.contact,
      // mesma chave do turno: o retry da fila não gera um segundo Operador
      sourceEventId: ids.job,
      payload: { conversation_id: ids.conversation, origin_job_id: ids.job, agent_id: 'agente-1', trigger: 'assistido' },
    });
    // o Operador entra DEPOIS do rascunho: falha dele nunca atrasa o rascunho
    expect(mocks.draft.mock.invocationCallOrder[0]!).toBeLessThan(mocks.enqueue.mock.invocationCallOrder[0]!);
  });

  it('papel do Operador desligado → rascunho sai, nada é enfileirado', async () => {
    await rodar(pool(agente({ operatorEnabled: false })));
    expect(mocks.draft).toHaveBeenCalledOnce();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('agente PAUSADO → nada é enfileirado (o operator_turn o barraria de qualquer jeito)', async () => {
    await rodar(pool(agente({ pausedAt: '2026-11-01T00:00:00Z' as never })));
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('gate de elegibilidade fechado → nem rascunho nem operator_turn (o turno não começou)', async () => {
    mocks.elegibilidade.mockResolvedValue({ permite: false, motivo: 'dono_humano' });
    await rodar(pool(agente()));
    expect(mocks.draft).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('falha ao enfileirar NÃO derruba o turno (e vira log de erro)', async () => {
    mocks.enqueue.mockRejectedValue(new Error('connection terminated'));
    await expect(rodar(pool(agente()))).resolves.toBeUndefined();
    expect(mocks.draft).toHaveBeenCalledOnce();
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('turno do operador NÃO foi enfileirado (assistido'),
      expect.anything(),
    );
  });
});
