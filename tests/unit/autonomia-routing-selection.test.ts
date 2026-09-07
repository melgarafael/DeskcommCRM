import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublishedAgentConfig } from '@/lib/agent-engine/agent/agent-config';

const mocks = vi.hoisted(() => ({
  router: vi.fn(), classify: vi.fn(), byId: vi.fn(), bySession: vi.fn(), conversationAgent: vi.fn(),
  draft: vi.fn(), operation: vi.fn(),
}));
vi.mock('@/lib/agent-engine/agent/router-config', () => ({ loadActiveRouter: mocks.router }));
vi.mock('@/lib/agent-engine/agent/intent-classifier', () => ({ classifyIntent: mocks.classify }));
vi.mock('@/lib/agent-engine/agent/agent-config', () => ({
  loadPublishedAgentConfigById: mocks.byId, loadPublishedAgentConfig: mocks.bySession,
  loadConversationAgentConfig: mocks.conversationAgent,
}));
vi.mock('@/lib/agent-engine/agent/reply-drafts', () => ({ generateReplyDraft: mocks.draft }));
vi.mock('@/lib/atendimento/fronteira-server', () => ({
  currentExecutionBoundary: () => undefined, setExecutionAgentOperation: mocks.operation,
  guardServiceEffect: vi.fn(),
}));
vi.mock('@/lib/agent-engine/agent/human-handoff', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(), isLeadInHandoff: vi.fn(async () => false),
}));
vi.mock('@/lib/agent-engine/guardrails/camadas-da-org', () => ({
  lerCamadasDaOrg: vi.fn(async () => ({})), camadaLigada: vi.fn(() => false),
}));
vi.mock('@/lib/agent-engine/agent/fuso-da-org', () => ({ fusoDaOrganizacao: vi.fn(async () => 'UTC') }));
vi.mock('@/lib/ai/elegibilidade/consulta-pg', () => ({ decidirElegibilidadeDaConversa: vi.fn(async () => null) }));
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
const deps = {
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  llmCfg: {}, crmCfg: {}, knobs: {},
} as unknown as InboundTurnDeps;
function agent(id: string, mode: 'automatic' | 'assisted', paused = false) {
  return { agentId: id, versionId: `version-${id}`, operationRevision: '7', operationMode: mode,
    pausedAt: paused ? '2026-09-06T12:00:00Z' : null } as PublishedAgentConfig;
}
function setup(a: PublishedAgentConfig, b: PublishedAgentConfig, sticky: boolean) {
  mocks.router.mockResolvedValue({ id: 'router', sticky: true, minConfidence: 0.6, fallbackAgentId: null,
    members: [{ agentId: 'A', intentName: 'vendas' }, { agentId: 'B', intentName: 'suporte' }] });
  mocks.classify.mockResolvedValue({ intentName: 'suporte', confidence: 0.95 });
  mocks.byId.mockImplementation(async (_db, _org, id) => id === 'B' ? b : a);
  // These remain valid alternatives; returning B here would hide the original bypass.
  mocks.bySession.mockResolvedValue(a);
  mocks.conversationAgent.mockResolvedValue(a);
  const query = vi.fn(async (_sql: string, values: unknown[]) => {
    expect(values).toEqual([ids.org, ids.conversation]);
    return { rows: [{ active_ai_agent_id: sticky ? 'A' : null, active_intent: sticky ? 'vendas' : null,
      body: 'Agora preciso de suporte técnico' }] };
  });
  return { query };
}
beforeEach(() => vi.clearAllMocks());

describe('operação segue a identidade escolhida pelo router canônico', () => {
  it.each(['assisted', 'paused'] as const)('A %s não captura a assistência selecionada de B', async state => {
    const a = agent('A', state === 'assisted' ? 'assisted' : 'automatic', state === 'paused');
    const b = agent('B', 'assisted');
    const pool = setup(a, b, true);
    await createInboundTurnHandler(deps)(job as never, pool as never, { workerId: 'worker' });
    expect(mocks.draft).toHaveBeenCalledOnce();
    expect(mocks.draft).toHaveBeenCalledWith(pool, deps, expect.objectContaining({
      agent: b, organizationId: ids.org, conversationId: ids.conversation, contactId: ids.contact,
    }));
    expect(mocks.classify).toHaveBeenCalledOnce();
    expect(mocks.byId).toHaveBeenCalledWith(pool, ids.org, 'B');
    expect(mocks.operation).not.toHaveBeenCalled();
  });

  it.each(['assisted', 'paused'] as const)('A %s não barra B automático e o core não resolve de novo', async state => {
    const b = agent('B', 'automatic');
    const pool = setup(agent('A', state === 'assisted' ? 'assisted' : 'automatic', state === 'paused'), b, false);
    // Stop at the operational boundary, after selection in the real core and before external effects.
    const reached = new Error('selected operation reached');
    mocks.operation.mockImplementationOnce(() => { throw reached; });
    await expect(createInboundTurnHandler(deps)(job as never, pool as never, { workerId: 'worker' })).rejects.toBe(reached);
    expect(mocks.operation).toHaveBeenCalledExactlyOnceWith({
      organizationId: ids.org, agentId: 'B', versionId: 'version-B', revision: '7',
    });
    expect(mocks.classify).toHaveBeenCalledOnce();
    expect(mocks.router).toHaveBeenCalledOnce();
    expect(mocks.draft).not.toHaveBeenCalled();
  });

  it('pausa do próprio B selecionado impede o turno, mesmo que A esteja automático', async () => {
    const pool = setup(agent('A', 'automatic'), agent('B', 'automatic', true), false);
    await createInboundTurnHandler(deps)(job as never, pool as never, { workerId: 'worker' });
    expect(mocks.classify).toHaveBeenCalledOnce();
    expect(mocks.draft).not.toHaveBeenCalled();
    expect(mocks.operation).not.toHaveBeenCalled();
  });
});
