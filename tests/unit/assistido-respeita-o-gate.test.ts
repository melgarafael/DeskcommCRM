/**
 * O rascunho do modo ASSISTIDO respeita as mesmas travas do automático.
 *
 * O drain (`lib/agent-engine/edge/crm/drain.ts`) desliga o gate de
 * elegibilidade antes de enfileirar quando a org tem agente assistido publicado
 * no canal (`canAssist`). Isso é deliberado — o rascunho é o produto do modo —
 * mas deixava o turno como ÚNICO responsável pela checagem, e o ramo assistido
 * de `createInboundTurnHandler` devolvia ANTES de `runAgentTurn`, onde as
 * guardas moram.
 *
 * O gate não é só o pré-go-live: na mesma consulta ele lê `contacts.force_human`,
 * `conversations.assignee_kind` (dono humano) e `bot_silenced_until`
 * (`lib/ai/elegibilidade/consulta-pg.ts`). Sem estas guardas, uma conversa que
 * uma PESSOA assumiu continuava recebendo rascunho do robô.
 *
 * O harness de mocks é o mesmo de `autonomia-routing-selection.test.ts`, de
 * propósito: mudar só a variável em teste.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublishedAgentConfig } from '@/lib/agent-engine/agent/agent-config';

const mocks = vi.hoisted(() => ({
  router: vi.fn(), classify: vi.fn(), byId: vi.fn(), bySession: vi.fn(), conversationAgent: vi.fn(),
  draft: vi.fn(), operation: vi.fn(), handoff: vi.fn(), elegibilidade: vi.fn(),
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
  ...await importOriginal<Record<string, unknown>>(), isLeadInHandoff: mocks.handoff,
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
const deps = {
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  llmCfg: {}, crmCfg: {}, knobs: {},
} as unknown as InboundTurnDeps;
const assistido = {
  agentId: 'A', versionId: 'version-A', operationRevision: '7', operationMode: 'assisted', pausedAt: null,
} as PublishedAgentConfig;

function pool() {
  mocks.router.mockResolvedValue(null);
  mocks.byId.mockResolvedValue(assistido);
  mocks.bySession.mockResolvedValue(assistido);
  mocks.conversationAgent.mockResolvedValue(assistido);
  return { query: vi.fn(async () => ({ rows: [{ active_ai_agent_id: null, active_intent: null, body: 'oi' }] })) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.handoff.mockResolvedValue(false);
  mocks.elegibilidade.mockResolvedValue(null);
});

describe('o assistido não rascunha em conversa que já tem dono', () => {
  // Um caso por MOTIVO real que a mesma consulta devolve: dono humano,
  // `force_human` e silêncio do bot. São ramos distintos da regra pura, e
  // testar só um deixaria os outros dois sem guarda.
  it.each(['dono_humano', 'force_human', 'bot_silenciado'] as const)(
    'gate diz não (%s) → nenhum rascunho é gerado',
    async motivo => {
      mocks.elegibilidade.mockResolvedValue({ permite: false, motivo });
      const p = pool();
      await createInboundTurnHandler(deps)(job as never, p as never, { workerId: 'worker' });
      expect(mocks.draft, 'gate fechado tem de calar o rascunho').not.toHaveBeenCalled();
      expect(mocks.operation).not.toHaveBeenCalled();
    },
  );

  it('lead em handoff humano → nenhum rascunho, e o gate nem chega a ser consultado', async () => {
    mocks.handoff.mockResolvedValue(true);
    const p = pool();
    await createInboundTurnHandler(deps)(job as never, p as never, { workerId: 'worker' });
    expect(mocks.draft).not.toHaveBeenCalled();
    expect(mocks.elegibilidade, 'handoff barra antes, sem gastar a consulta').not.toHaveBeenCalled();
  });

  // Controle positivo: sem este caso, um `return` cedo demais deixaria os três
  // acima verdes por AUSÊNCIA — o modo assistido inteiro morto e o teste feliz.
  it('gate aberto → o rascunho SAI (controle positivo)', async () => {
    mocks.elegibilidade.mockResolvedValue({ permite: true, motivo: 'gate_aberto' });
    const p = pool();
    await createInboundTurnHandler(deps)(job as never, p as never, { workerId: 'worker' });
    expect(mocks.draft).toHaveBeenCalledOnce();
    expect(mocks.draft).toHaveBeenCalledWith(p, deps, expect.objectContaining({
      agent: assistido, organizationId: ids.org, conversationId: ids.conversation, contactId: ids.contact,
    }));
  });

  it('consulta de elegibilidade quebrada degrada ABERTO — o assistido não emudece por erro de infra', async () => {
    mocks.elegibilidade.mockRejectedValue(new Error('connection terminated'));
    const p = pool();
    await createInboundTurnHandler(deps)(job as never, p as never, { workerId: 'worker' });
    expect(mocks.draft).toHaveBeenCalledOnce();
  });
});
