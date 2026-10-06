/**
 * FILTRO POR ETIQUETA, NO TURNO DE VERDADE.
 *
 * Não é gatilho: o contato escreve, e o agente só responde se passar no filtro
 * de etiquetas da versão publicada dele. Quando nenhum agente do número aceita,
 * o turno termina calado — antes de qualquer chamada de modelo, sem rascunho e
 * sem cair no agente genérico (que é o que `config: null` faria sem a regra 8).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublishedAgentConfig } from '@/lib/agent-engine/agent/agent-config';

const mocks = vi.hoisted(() => ({
  router: vi.fn(), classify: vi.fn(), byId: vi.fn(), agentesDaSessao: vi.fn(), conversationAgent: vi.fn(),
  draft: vi.fn(), operation: vi.fn(),
  handoff: vi.fn(async () => false), elegibilidade: vi.fn(async (): Promise<unknown> => null),
  jev: vi.fn(() => ({ estado: Promise.resolve('desligada'), escolha: Promise.resolve(null), observar: vi.fn() })),
}));
vi.mock('@/lib/ai/decisao/roteador', () => ({ consultarJevNoRoteador: mocks.jev }));
vi.mock('@/lib/agent-engine/agent/router-config', () => ({ loadActiveRouter: mocks.router }));
vi.mock('@/lib/agent-engine/agent/intent-classifier', () => ({ classifyIntent: mocks.classify }));
vi.mock('@/lib/agent-engine/agent/agent-config', () => ({
  loadPublishedAgentConfigById: mocks.byId,
  loadPublishedAgentConfigsDaSessao: mocks.agentesDaSessao,
  loadPublishedAgentConfig: vi.fn(async () => null),
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
vi.mock('@/lib/agent-engine/agent/turno-ja-respondido', () => ({
  ultimaInboundJaRespondida: vi.fn(async () => false),
  anotarUltimaInboundVista: vi.fn(async () => {}),
}));
vi.mock('@/lib/agent-engine/pacing/store', () => ({ loadChannelKnobs: vi.fn(async () => ({ knobs: {} })) }));
vi.mock('@/lib/agent-engine/pacing/engine', () => ({ janelaDeEnvioAberta: () => true, proximaAberturaDaJanela: vi.fn() }));
vi.mock('@/lib/agent-engine/pacing/aviso-de-janela', () => ({
  resolverAvisoDeJanela: vi.fn(async () => 0), avisarJanelaFechada: vi.fn(),
}));

import { createInboundTurnHandler, runAgentTurn, type InboundTurnDeps } from '@/lib/agent-engine/agent/inbound-turn';

const ids = {
  org: '12000000-0000-4000-8000-000000000001', contact: '12000000-0000-4000-8000-000000000002',
  conversation: '12000000-0000-4000-8000-000000000003', channel: '12000000-0000-4000-8000-000000000004',
  job: '12000000-0000-4000-8000-000000000005',
};
const job = {
  id: ids.job, organization_id: ids.org, contact_id: ids.contact, kind: 'inbound_turn',
  payload: { conversation_id: ids.conversation, contact_id: ids.contact, channel_session_id: ids.channel,
    inbound_message_id: '12000000-0000-4000-8000-000000000006', crm_event_id: '12000000-0000-4000-8000-000000000007' },
};
const deps = {
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  llmCfg: {}, crmCfg: {}, knobs: {},
} as unknown as InboundTurnDeps;

function agente(id: string, incluir: string[], excluir: string[] = []): PublishedAgentConfig {
  return { agentId: id, versionId: `version-${id}`, operationRevision: '7', operationMode: 'automatic',
    pausedAt: null, filtroDeEtiquetas: { incluir, excluir } } as PublishedAgentConfig;
}

/** Banco falso: toda leitura devolve a conversa, com as etiquetas do contato. */
function banco(etiquetas: string[]) {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('id<>$3')) return { rows: [] };
      return { rows: [{ active_ai_agent_id: null, active_intent: null, body: 'Oi, tudo bem?', contact_tags: etiquetas }] };
    }),
  };
}

const chegou = new Error('operação do agente escolhido alcançada');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.handoff.mockResolvedValue(false);
  mocks.elegibilidade.mockResolvedValue(null);
  mocks.router.mockResolvedValue(null);
  // Para no limite operacional: depois da escolha, antes de qualquer efeito externo.
  mocks.operation.mockImplementation(() => { throw chegou; });
});

describe('o agente só responde quem passa no filtro de etiquetas', () => {
  it('contato sem a etiqueta: turno termina calado, sem rascunho e sem operação', async () => {
    mocks.agentesDaSessao.mockResolvedValue([agente('A', ['cliente'])]);
    await createInboundTurnHandler(deps)(job as never, banco([]) as never, { workerId: 'worker' });
    expect(mocks.operation).not.toHaveBeenCalled();
    expect(mocks.draft).not.toHaveBeenCalled();
    expect(deps.log.info).toHaveBeenCalledWith(
      'turno pulado — nenhum agente aceita as etiquetas do contato', expect.anything());
  });

  // Controle: sem ele, um `return` cedo demais deixaria o caso acima verde por ausência.
  it('contato com a etiqueta: o turno segue com o agente', async () => {
    mocks.agentesDaSessao.mockResolvedValue([agente('A', ['cliente'])]);
    await expect(createInboundTurnHandler(deps)(job as never, banco(['cliente']) as never, { workerId: 'worker' }))
      .rejects.toBe(chegou);
    expect(mocks.operation).toHaveBeenCalledExactlyOnceWith({
      organizationId: ids.org, agentId: 'A', versionId: 'version-A', revision: '7',
    });
  });

  it('dois agentes no número: cada contato cai no agente da etiqueta dele', async () => {
    mocks.agentesDaSessao.mockResolvedValue([agente('A', ['cliente']), agente('B', ['lead'])]);
    await expect(createInboundTurnHandler(deps)(job as never, banco(['lead']) as never, { workerId: 'worker' }))
      .rejects.toBe(chegou);
    expect(mocks.operation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ agentId: 'B' }));
  });

  it('"nunca responder quem tem" vence: contato com as duas etiquetas fica sem resposta', async () => {
    mocks.agentesDaSessao.mockResolvedValue([agente('A', ['cliente'], ['inadimplente'])]);
    await createInboundTurnHandler(deps)(job as never, banco(['cliente', 'inadimplente']) as never, { workerId: 'worker' });
    expect(mocks.operation).not.toHaveBeenCalled();
    // Sem esta linha o caso passaria também caindo no genérico, que nunca chama a operação.
    expect(deps.log.info).toHaveBeenCalledWith(
      'turno pulado — nenhum agente aceita as etiquetas do contato', expect.anything());
  });
});

/**
 * Follow-up e resposta de caso entram por `runAgentTurn` SEM agente já
 * resolvido: a saída que os protege é a do próprio turno, não a do handler do
 * inbound. Sem ela, um follow-up da IA iria pelo agente genérico para o contato
 * que o filtro recusa.
 */
describe('follow-up da IA também respeita o filtro', () => {
  const followup = {
    ...job,
    kind: 'followup_turn',
    payload: { conversation_id: ids.conversation, contact_id: ids.contact, channel_session_id: ids.channel, purpose: 'send_message' },
  };
  const entrada = {
    channelSessionId: ids.channel,
    conversationId: ids.conversation,
    buildOpening: () => { throw new Error('a abertura não deveria ser montada'); },
  };

  it('contato recusado: o follow-up termina calado, sem operação', async () => {
    mocks.agentesDaSessao.mockResolvedValue([agente('A', ['cliente'])]);
    await runAgentTurn(deps, followup as never, banco([]) as never, { workerId: 'worker' }, entrada as never);
    expect(mocks.operation).not.toHaveBeenCalled();
    expect(deps.log.info).toHaveBeenCalledWith(
      'turno pulado — nenhum agente aceita as etiquetas do contato', expect.anything());
  });

  // Controle: o mesmo follow-up para um contato aceito chega à operação.
  it('contato aceito: o follow-up segue com o agente', async () => {
    mocks.agentesDaSessao.mockResolvedValue([agente('A', ['cliente'])]);
    await expect(runAgentTurn(deps, followup as never, banco(['cliente']) as never, { workerId: 'worker' }, entrada as never))
      .rejects.toBe(chegou);
    expect(mocks.operation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ agentId: 'A' }));
  });
});
