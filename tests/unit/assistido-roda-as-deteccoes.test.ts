/**
 * #1648 — O MODO ASSISTIDO TAMBÉM OUVE AS DETERMINÍSTICAS.
 *
 * O ramo assistido devolvia ANTES das detecções de STOP/opt-out e de pedido de
 * humano. Na prática, com o agente em `operation_mode = 'assisted'`:
 *
 *   1. "SAIR" / "pare de me mandar mensagem" não registrava nada — o bot
 *      seguia elegível e os follow-ups agendados continuavam vivos (risco de
 *      LGPD: o pedido de parar esperava uma aprovação de rascunho que podia
 *      nunca vir);
 *   2. "quero falar com uma pessoa" virava só um rascunho, sem item de handoff
 *      na Central;
 *   3. um `followup_turn` de agente assistido caía no `return` genérico e sumia
 *      — sem envio, sem rascunho e sem aviso.
 *
 * Os três casos daqui são RED antes do fix e GREEN depois (a sabotagem é
 * reverter `lib/agent-engine/agent/inbound-turn.ts` e re-rodar). O controle
 * positivo (#4) é o que impede o "verde por ausência": sem ele, matar o modo
 * assistido inteiro deixaria os vermelhos todos verdes.
 *
 * O HARNESS é o mesmo de `assistido-respeita-o-gate.test.ts`, de propósito:
 * mudar só a variável em teste. As detecções são dirigidas pelo CAMINHO DE
 * PRODUÇÃO (`createInboundTurnHandler` para inbound, `runAgentTurn` para o
 * follow-up) e não pela função auxiliar, porque o defeito é de ORDENÇÃO e uma
 * função testada sozinha não prova ordem nenhuma.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublishedAgentConfig } from '@/lib/agent-engine/agent/agent-config';

const mocks = vi.hoisted(() => ({
  router: vi.fn(),
  classify: vi.fn(),
  byId: vi.fn(),
  bySession: vi.fn(),
  conversationAgent: vi.fn(),
  draft: vi.fn(),
  passagem: vi.fn(),
  aviso: vi.fn(),
  avisoLendo: vi.fn(),
  cancel: vi.fn(),
  emHandoff: vi.fn(),
  elegibilidade: vi.fn(),
  leadContext: vi.fn(),
}));

vi.mock('@/lib/agent-engine/agent/router-config', () => ({ loadActiveRouter: mocks.router }));
vi.mock('@/lib/agent-engine/agent/intent-classifier', () => ({ classifyIntent: mocks.classify }));
// O spread do original É obrigatório aqui: o ramo assistido agora usa
// `matchesHandoffKeyword` DESTE módulo. Mock de módulo inteiro sem ele deixava
// a chamada virar `undefined is not a function` no meio do turno.
vi.mock('@/lib/agent-engine/agent/agent-config', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadPublishedAgentConfigById: mocks.byId,
  loadPublishedAgentConfig: mocks.bySession,
  loadConversationAgentConfig: mocks.conversationAgent,
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
  cancelPendingCronsForLead: mocks.cancel,
}));
vi.mock('@/lib/agent-engine/edge/crm/get-lead-context', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getLeadContext: mocks.leadContext,
}));
vi.mock('@/lib/agent-engine/guardrails/camadas-da-org', () => ({
  lerCamadasDaOrg: vi.fn(async () => ({})),
  camadaLigada: vi.fn(() => false),
}));
vi.mock('@/lib/agent-engine/agent/fuso-da-org', () => ({
  fusoDaOrganizacao: vi.fn(async () => 'UTC'),
}));
vi.mock('@/lib/ai/elegibilidade/consulta-pg', () => ({
  decidirElegibilidadeDaConversa: mocks.elegibilidade,
}));
vi.mock('@/lib/agent-engine/pacing/store', () => ({
  loadChannelKnobs: vi.fn(async () => ({ knobs: {} })),
}));
vi.mock('@/lib/agent-engine/pacing/engine', () => ({
  janelaDeEnvioAberta: () => true,
  proximaAberturaDaJanela: vi.fn(),
}));
vi.mock('@/lib/agent-engine/pacing/aviso-de-janela', () => ({
  resolverAvisoDeJanela: vi.fn(async () => 0),
  avisarJanelaFechada: vi.fn(),
}));

import {
  createInboundTurnHandler,
  runAgentTurn,
  type InboundTurnDeps,
} from '@/lib/agent-engine/agent/inbound-turn';

const ids = {
  org: '11000000-0000-4000-8000-000000000001',
  contact: '11000000-0000-4000-8000-000000000002',
  conversation: '11000000-0000-4000-8000-000000000003',
  channel: '11000000-0000-4000-8000-000000000004',
  job: '11000000-0000-4000-8000-000000000005',
  mensagem: '11000000-0000-4000-8000-000000000006',
  evento: '11000000-0000-4000-8000-000000000007',
  followup: '11000000-0000-4000-8000-000000000008',
};

const inbound = {
  id: ids.job,
  organization_id: ids.org,
  contact_id: ids.contact,
  kind: 'inbound_turn',
  payload: {
    conversation_id: ids.conversation,
    contact_id: ids.contact,
    channel_session_id: ids.channel,
    inbound_message_id: ids.mensagem,
    crm_event_id: ids.evento,
  },
};

const followup = {
  id: ids.followup,
  organization_id: ids.org,
  contact_id: ids.contact,
  kind: 'followup_turn',
  payload: { conversation_id: ids.conversation, contact_id: ids.contact },
};

const deps = {
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  llmCfg: {},
  crmCfg: {},
  knobs: {},
  // Seam de canal injetado: o aviso da passagem nunca constrói um adapter real.
  channel: () => ({ send: vi.fn(async () => ({ kind: 'sent' })) }),
} as unknown as InboundTurnDeps;

const assistido = {
  agentId: 'A',
  versionId: 'version-A',
  operationRevision: '7',
  operationMode: 'assisted',
  pausedAt: null,
  handoffKeywords: ['suporte'],
} as PublishedAgentConfig;

function pool() {
  mocks.router.mockResolvedValue(null);
  mocks.byId.mockResolvedValue(assistido);
  mocks.bySession.mockResolvedValue(assistido);
  mocks.conversationAgent.mockResolvedValue(assistido);
  return {
    query: vi.fn(async (sql: string) => {
      // Devolve o formato da QUERY, não um row genérico: `latestCheckpoint` lê
      // `select * from lead_checkpoints` e um row de conversa viraria um
      // checkpoint sem `rolling_summary` (TypeError em quem monta o briefing).
      if (typeof sql === 'string' && sql.includes('lead_checkpoints')) return { rows: [] };
      return { rows: [{ active_ai_agent_id: null, active_intent: null, body: 'oi' }] };
    }),
  };
}

/** O contexto do lead como o turno o enxerga — fonte dos inbounds pendentes. */
function contexto(
  mensagens: Array<{ direction: 'inbound' | 'outbound'; body: string }>,
  isBlocked = false,
) {
  return {
    ok: true,
    tokenCount: 12,
    lgpd: { isAnonymized: false },
    context: {
      lead_id: ids.contact,
      contact: { name: 'Cliente', phone: null, email: null, tags: [], is_blocked: isBlocked },
      conversation_id: ids.conversation,
      last_human_decision: null,
      messages: mensagens,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.emHandoff.mockResolvedValue(false);
  mocks.elegibilidade.mockResolvedValue({ permite: true, motivo: 'gate_aberto' });
  mocks.aviso.mockResolvedValue({ avisado: true });
  mocks.avisoLendo.mockResolvedValue({ avisado: true });
  mocks.passagem.mockResolvedValue(undefined);
  mocks.cancel.mockResolvedValue(2);
  mocks.leadContext.mockResolvedValue(contexto([{ direction: 'inbound', body: 'oi, tudo bem?' }]));
});

describe('modo assistido: as detecções determinísticas rodam antes do rascunho (#1648)', () => {
  // (1) STOP/OPT-OUT — o caso de LGPD. O rascunho pendente de aprovação não
  // segura este ramo: o pedido de parar é registrado AGORA.
  it('STOP no inbound → aviso + passagem de opt-out, e NENHUM rascunho', async () => {
    mocks.leadContext.mockResolvedValue(contexto([{ direction: 'inbound', body: 'SAIR' }]));
    const p = pool();
    await createInboundTurnHandler(deps)(inbound as never, p as never, { workerId: 'w' });

    // O aviso sai ANTES da passagem — ordem obrigação (force_human armaria o
    // gate que o vetaria). É a mesma ordem do caminho automático.
    expect(mocks.aviso).toHaveBeenCalledTimes(1);
    expect(mocks.aviso.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({ motivo: 'suspeita_de_opt_out' }),
    );
    // `performHumanHandoff` é o que silencia para sempre E cancela os crons
    // agendados (F4-07) — o mesmo mecanismo durável do automático.
    expect(mocks.passagem).toHaveBeenCalledTimes(1);
    expect(mocks.passagem).toHaveBeenCalledWith(
      p,
      { tenantId: ids.org, leadId: ids.contact, conversationId: ids.conversation },
      expect.objectContaining({ reason: 'suspected_optout' }),
    );
    expect(mocks.draft, 'quem pediu para parar não ganha rascunho').not.toHaveBeenCalled();
  });

  // (2) PEDIDO DE HUMANO — a detecção regex built-in (F4-06).
  it('pedido explícito de humano → passagem de handoff na Central, não rascunho', async () => {
    mocks.leadContext.mockResolvedValue(
      contexto([{ direction: 'inbound', body: 'quero falar com uma pessoa' }]),
    );
    const p = pool();
    await createInboundTurnHandler(deps)(inbound as never, p as never, { workerId: 'w' });

    expect(mocks.passagem).toHaveBeenCalledWith(
      p,
      { tenantId: ids.org, leadId: ids.contact, conversationId: ids.conversation },
      expect.objectContaining({
        reason: 'requested_human',
        passagem: expect.objectContaining({ origem: 'pedido_explicito' }),
      }),
    );
    expect(mocks.draft).not.toHaveBeenCalled();
  });

  // (2b) A PALAVRA-CHAVE CONFIGURADA na tela (`matchesHandoffKeyword`) — o caso
  // que a issue nomeia literalmente: o agente assistido tem keyword e o card
  // não recebia item nenhum.
  it('palavra-chave de handoff configurada → passagem, não só rascunho', async () => {
    mocks.leadContext.mockResolvedValue(
      contexto([{ direction: 'inbound', body: 'abre um chamado no suporte pra mim' }]),
    );
    const p = pool();
    await createInboundTurnHandler(deps)(inbound as never, p as never, { workerId: 'w' });

    expect(mocks.passagem).toHaveBeenCalledTimes(1);
    expect(mocks.draft).not.toHaveBeenCalled();
  });

  // (1, plano B) CONTEXTO NÃO LIDO: a detecção cai na mensagem fixada no job, e
  // sem o contexto não há `lgpd` — com ele nulo o gate de LGPD passa direto e um
  // contato anonimizado receberia o aviso. O aviso tem de sair pelo emissor que
  // lê o contato do banco.
  it('STOP com o CRM fora → aviso lendo o contato do banco, e a passagem acontece', async () => {
    mocks.leadContext.mockResolvedValue({ ok: false, error: { code: 'crm_unavailable' } });
    const p = pool();
    p.query.mockImplementation(async (sql: string) => {
      if (sql.includes('lead_checkpoints')) return { rows: [] };
      if (sql.includes('from messages') && sql.includes('and id = $3')) {
        return { rows: [{ active_ai_agent_id: null, active_intent: null, body: 'SAIR' }] };
      }
      return { rows: [{ active_ai_agent_id: null, active_intent: null, body: 'oi' }] };
    });
    await createInboundTurnHandler(deps)(inbound as never, p as never, { workerId: 'w' });

    expect(mocks.avisoLendo).toHaveBeenCalledTimes(1);
    expect(mocks.avisoLendo.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({ motivo: 'suspeita_de_opt_out' }),
    );
    expect(mocks.avisoLendo.mock.calls[0]?.[2]).not.toHaveProperty('lgpd');
    expect(mocks.aviso, 'sem contexto, o aviso sem lgpd não pode sair').not.toHaveBeenCalled();
    expect(mocks.passagem).toHaveBeenCalledWith(
      p,
      { tenantId: ids.org, leadId: ids.contact, conversationId: ids.conversation },
      expect.objectContaining({ reason: 'suspected_optout' }),
    );
    expect(mocks.draft).not.toHaveBeenCalled();
  });

  // CONTROLE POSITIVO — sem ele os quatro vermelhos de cima ficariam verdes
  // por AUSÊNCIA se o modo assistido inteiro morresse.
  it('mensagem comum → o rascunho SAI e nada é escalado (controle)', async () => {
    const p = pool();
    await createInboundTurnHandler(deps)(inbound as never, p as never, { workerId: 'w' });

    expect(mocks.draft).toHaveBeenCalledTimes(1);
    expect(mocks.draft).toHaveBeenCalledWith(
      p,
      deps,
      expect.objectContaining({ agent: assistido, organizationId: ids.org }),
    );
    expect(mocks.passagem).not.toHaveBeenCalled();
    expect(mocks.aviso).not.toHaveBeenCalled();
  });

  // (1, corolário) O opt-out JÁ registrado na fonte: sem mensagem nova que
  // casasse, mas os crons agendados têm de morrer no mesmo turno.
  it('contato já bloqueado no CRM → follow-ups agendados cancelados agora', async () => {
    mocks.leadContext.mockResolvedValue(
      contexto([{ direction: 'inbound', body: 'oi, tudo bem?' }], true),
    );
    const p = pool();
    await createInboundTurnHandler(deps)(inbound as never, p as never, { workerId: 'w' });

    expect(mocks.cancel).toHaveBeenCalledWith(p, ids.org, ids.contact);
  });

  // (3) FOLLOW-UP — caía no `return` genérico e sumia: sem envio, sem rascunho
  // e sem aviso. Agora vira rascunho, como o inbound.
  it('follow-up de agente assistido vira rascunho em vez de sumir', async () => {
    const p = pool();
    await runAgentTurn(
      deps,
      followup as never,
      p as never,
      { workerId: 'w' },
      {
        resolvedAgent: {
          config: assistido,
          routerId: null,
          intentName: null,
          confidence: null,
          outcome: 'fallback',
        },
        channelSessionId: ids.channel,
        conversationId: ids.conversation,
        buildOpening: () => '',
      } as never,
    );

    expect(mocks.draft, 'o follow-up do assistido não pode sumir em silêncio').toHaveBeenCalledTimes(
      1,
    );
    expect(mocks.draft).toHaveBeenCalledWith(
      p,
      deps,
      expect.objectContaining({ agent: assistido, conversationId: ids.conversation }),
    );
  });
});

/**
 * FIAÇÃO — a ordem é o defeito, e ordem não se prova chamando a função isolada.
 *
 * O mesmo argumento de `rajada-nao-cala-o-pedido-de-humano.test.ts`: presença
 * antes de qualquer coisa. Um `return` movido para cima do detection re-abre o
 * buraco LGPD e os testes de comportamento acima continuariam verdes só se o
 * rascunho fosse gerado — aqui é a POSIÇÃO que se vigia.
 */
describe('fiação — a detecção vem ANTES do desvio para o rascunho', () => {
  const FONTE = readFileSync(join(process.cwd(), 'lib/agent-engine/agent/inbound-turn.ts'), 'utf8');

  function trecho(assinatura: string): string {
    const i = FONTE.indexOf(assinatura);
    expect(i, `assinatura ausente do fonte: ${assinatura}`).toBeGreaterThan(-1);
    return FONTE.slice(i);
  }

  it('createInboundTurnHandler (inbound) detecta antes de rascunhar', () => {
    const t = trecho('export function createInboundTurnHandler(');
    const det = t.indexOf('deteccoesDeterministicasDoAssistido(');
    const rascunho = t.indexOf('generateReplyDraft(');
    expect(det, 'o ramo assistido do handler não roda as detecções').toBeGreaterThan(-1);
    expect(rascunho, 'o rascunho sumiu do ramo assistido').toBeGreaterThan(det);
  });

  it('executarTurnoDoAgente detecta antes de rascunhar, e o follow-up entra no ramo', () => {
    const t = trecho('async function executarTurnoDoAgente(');
    const det = t.indexOf('deteccoesDeterministicasDoAssistido(');
    const rascunho = t.indexOf('generateReplyDraft(');
    expect(det, 'o ramo assistido do turno não roda as detecções').toBeGreaterThan(-1);
    expect(rascunho).toBeGreaterThan(det);
    expect(t).toMatch(/job\.kind === 'followup_turn'/);
  });
});
