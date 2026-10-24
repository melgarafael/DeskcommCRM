/**
 * STOP E PEDIDO DE HUMANO VENCEM A RESTRIÇÃO COMERCIAL (#3270, defeito 1).
 *
 * A passagem comercial (`escalarComercialAntesDoModelo`) roda no handler, antes
 * de escolher o agente — e as detecções determinísticas de opt-out e de pedido
 * de humano moram depois dela. Uma mensagem mista ("quanto custa? para de me
 * mandar mensagem") caía no desvio comercial: o cliente recebia o aviso de
 * "valores com a equipe" e o turno voltava SEM registrar o opt-out (LGPD).
 *
 * Mede o handler de verdade, com a leitura REAL da camada (`comercialExigeHumano`
 * contra um pool que responde por SQL) e o agente ASSISTIDO — o caminho em que a
 * detecção determinística roda no próprio handler, logo depois do roteador.
 * O controle (mensagem só comercial → passagem comercial) é o que impede o
 * verde por ausência: prova que a restrição está LIGADA neste harness.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublishedAgentConfig } from '@/lib/agent-engine/agent/agent-config';

const mocks = vi.hoisted(() => ({
  router: vi.fn(),
  classify: vi.fn(),
  agente: vi.fn(),
  draft: vi.fn(),
  passagem: vi.fn(),
  aviso: vi.fn(),
  avisoLendo: vi.fn(),
  emHandoff: vi.fn(),
  leadContext: vi.fn(),
}));

vi.mock('@/lib/agent-engine/agent/router-config', () => ({ loadActiveRouter: mocks.router }));
vi.mock('@/lib/agent-engine/agent/intent-classifier', () => ({ classifyIntent: mocks.classify }));
vi.mock('@/lib/agent-engine/agent/agent-config', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadPublishedAgentConfigById: mocks.agente,
  loadPublishedAgentConfig: mocks.agente,
  loadConversationAgentConfig: mocks.agente,
}));
vi.mock('@/lib/agent-engine/agent/reply-drafts', () => ({ generateReplyDraft: mocks.draft }));
vi.mock('@/lib/atendimento/fronteira-server', () => ({
  currentExecutionBoundary: () => undefined,
  setExecutionAgentOperation: vi.fn(),
  guardServiceEffect: vi.fn(),
}));
vi.mock('@/lib/agent-engine/agent/human-handoff', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isLeadInHandoff: mocks.emHandoff,
  performHumanHandoff: mocks.passagem,
}));
vi.mock('@/lib/agent-engine/agent/aviso-de-escalacao', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  avisarLeadDaEscalacao: mocks.aviso,
  avisarLeadLendoOContato: mocks.avisoLendo,
}));
vi.mock('@/lib/agent-engine/cron/scheduler', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  cancelPendingCronsForLead: vi.fn(async () => 0),
}));
vi.mock('@/lib/agent-engine/edge/crm/get-lead-context', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getLeadContext: mocks.leadContext,
}));
// Só o automático chega aqui: o turno monta o prompt antes das detecções.
vi.mock('@/lib/agent-engine/agent/playbook', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadPlaybook: vi.fn(async () => ({ prompt: '## Identidade\nTeste.', versionIds: {} })),
}));
vi.mock('@/lib/agent-engine/agent/fuso-da-org', () => ({ fusoDaOrganizacao: vi.fn(async () => 'UTC') }));
vi.mock('@/lib/ai/elegibilidade/consulta-pg', () => ({ decidirElegibilidadeDaConversa: vi.fn(async () => null) }));

import { createInboundTurnHandler, type InboundTurnDeps } from '@/lib/agent-engine/agent/inbound-turn';

const ids = {
  org: '13000000-0000-4000-8000-000000000001', contact: '13000000-0000-4000-8000-000000000002',
  conversation: '13000000-0000-4000-8000-000000000003', channel: '13000000-0000-4000-8000-000000000004',
  job: '13000000-0000-4000-8000-000000000005',
};
const job = {
  id: ids.job, organization_id: ids.org, contact_id: ids.contact, kind: 'inbound_turn',
  payload: { conversation_id: ids.conversation, contact_id: ids.contact, channel_session_id: ids.channel,
    inbound_message_id: '13000000-0000-4000-8000-000000000006', crm_event_id: '13000000-0000-4000-8000-000000000007' },
};
const deps = {
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  llmCfg: {}, crmCfg: {}, knobs: {},
  // Relógio fixo DENTRO da janela anti-ban: com o relógio real, o turno do
  // automático é adiado à noite (antes das detecções) e o teste só passava de dia.
  clock: () => new Date('2026-10-21T15:00:00Z'),
  channel: () => ({ send: vi.fn(async () => ({ kind: 'sent' })) }),
} as unknown as InboundTurnDeps;
const assistido = {
  agentId: 'A', versionId: 'version-A', operationRevision: '7', operationMode: 'assisted',
  pausedAt: null, handoffKeywords: [],
} as unknown as PublishedAgentConfig;

/** A camada LIGADA, lida de verdade; e a mensagem pendente, nas duas fontes. */
function rodar(mensagem: string) {
  mocks.leadContext.mockResolvedValue({
    ok: true, tokenCount: 12, lgpd: { isAnonymized: false },
    context: {
      lead_id: ids.contact, conversation_id: ids.conversation, last_human_decision: null,
      contact: { name: 'Cliente', phone: null, email: null, tags: [], is_blocked: false },
      messages: [{ direction: 'inbound', body: mensagem }],
    },
  });
  const pool = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('org_guardrail_layers')) return { rows: [{ enabled: true }] };
      if (sql.includes('from messages m')) return { rows: [{ body: mensagem }] };
      if (sql.includes('lead_checkpoints')) return { rows: [] };
      return { rows: [{ active_ai_agent_id: null, active_intent: null, body: mensagem }] };
    }),
  };
  return createInboundTurnHandler(deps)(job as never, pool as never, { workerId: 'w' });
}

const passagemComercial = () =>
  mocks.passagem.mock.calls.filter((c) => String((c[2] as { inboxTitle?: string })?.inboxTitle ?? '').startsWith('Valores e negociação'));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.router.mockResolvedValue(null);
  mocks.agente.mockResolvedValue(assistido);
  mocks.emHandoff.mockResolvedValue(false);
  mocks.aviso.mockResolvedValue({ avisado: true });
  mocks.avisoLendo.mockResolvedValue({ avisado: true });
  mocks.passagem.mockResolvedValue(undefined);
});

describe('restrição comercial cede ao opt-out e ao pedido de humano', () => {
  it('mensagem mista com opt-out: o opt-out é registrado e o cliente NÃO recebe o aviso comercial', async () => {
    await rodar('Quanto custa? Para de me mandar mensagem');
    expect(mocks.avisoLendo, 'o aviso comercial sai por avisarLeadLendoOContato').not.toHaveBeenCalled();
    expect(passagemComercial()).toEqual([]);
    expect(mocks.aviso).toHaveBeenCalledOnce();
    expect(mocks.aviso.mock.calls[0]?.[2]).toMatchObject({ motivo: 'suspeita_de_opt_out' });
    expect(mocks.passagem).toHaveBeenCalledOnce();
    expect(mocks.passagem.mock.calls[0]?.[2]).toMatchObject({ reason: 'suspected_optout' });
    expect(mocks.draft).not.toHaveBeenCalled();
  });

  it('mensagem mista com pedido de humano: vai como pedido de humano, não como assunto comercial', async () => {
    await rodar('Qual o preço? Quero falar com um atendente');
    expect(mocks.avisoLendo).not.toHaveBeenCalled();
    expect(passagemComercial()).toEqual([]);
    expect(mocks.passagem.mock.calls[0]?.[2]).toMatchObject({ reason: 'requested_human' });
  });

  // O automático não tem a detecção no handler: ela mora DENTRO do turno
  // (`executarTurnoDoAgente`). A passagem comercial precisa ceder até lá.
  it('modo AUTOMÁTICO: a mensagem mista chega ao ramo de suspeita de opt-out dentro do turno', async () => {
    mocks.agente.mockResolvedValue({ ...assistido, operationMode: 'automatic', toolIds: [], knowledgeSourceIds: [],
      systemPrompt: '', provider: 'anthropic', model: 'claude-teste', credentialId: null, maxSteps: 4,
      historyMessageWindow: 10, historyTokenWindow: 1000, handoffToolEnabled: false, splitMessages: false,
      casesEnabled: false, multimodalInput: false });
    await rodar('Quanto custa? Para de me mandar mensagem');
    expect(mocks.avisoLendo).not.toHaveBeenCalled();
    expect(passagemComercial()).toEqual([]);
    expect(mocks.aviso.mock.calls[0]?.[2]).toMatchObject({ motivo: 'suspeita_de_opt_out' });
    expect(mocks.passagem).toHaveBeenCalledOnce();
    expect(mocks.passagem.mock.calls[0]?.[2]).toMatchObject({ reason: 'suspected_optout' });
    expect(vi.mocked(deps.log.info).mock.calls.map((c) => c[0]))
      .toContain('possível opt-out detectado no inbound — bot silenciado e escalado ao humano');
  });

  it('CONTROLE: só preço, com a camada ligada → passagem comercial (a restrição está armada aqui)', async () => {
    await rodar('Quanto custa o óculos?');
    expect(mocks.avisoLendo).toHaveBeenCalledOnce();
    expect(mocks.avisoLendo.mock.calls[0]?.[2]).toMatchObject({ motivo: 'outro' });
    expect(passagemComercial()).toHaveLength(1);
    expect(mocks.router, 'a passagem comercial vem antes do roteador').not.toHaveBeenCalled();
  });
});
