/**
 * #4679 — A PASSAGEM AUTOMÁTICA NÃO PODE REAPRESENTAR O MESMO AGENTE.
 *
 * O defeito medido pelo autor, em produção (1.111.0): número com roteador sticky
 * em que o agente de reserva TAMBÉM é membro de uma intenção. A conversa entra
 * pela reserva (intenção sticky `null`), e a primeira intenção casada — a do
 * PRÓPRIO agente que já atende — conta como "troca" (`reclassified` com
 * `agent_id` igual ao anterior). O turno injeta o bloco de passagem, e o cliente
 * lê uma segunda apresentação ("...vou continuar seu atendimento") do mesmo
 * agente, no meio da conversa.
 *
 * A trilha que a issue registra, e que o primeiro caso reproduz turno a turno:
 *
 *   | ordem | outcome      | agent_id | intent |
 *   | 1     | fallback     | A        | —      |
 *   | 2     | sticky       | A        | —      |
 *   | 3     | reclassified | A        | A      |
 *
 * O conserto NÃO mexe na classificação nem no `outcome` gravado: o turno 3
 * continua `reclassified` (é o que a telemetria registra), mas a passagem ao
 * agente só existe quando o par (agente anterior, agente novo) muda de verdade.
 */
import { describe, expect, it, vi } from 'vitest';

import { buildOpeningMessage } from '@/lib/agent-engine/agent/abertura/ritual';
import { disclosureGate } from '@/lib/agent-engine/guardrails/before-send';
import {
  TITULO_DO_BLOCO_DE_PASSAGEM,
  montarBlocoDePassagemDoRoteador,
} from '@/lib/agent-engine/agent/passagem-do-roteador';
import type { PublishedAgentConfig } from './agent-config';
import type { LoadedRouter } from './router-config';
import { resolveTurnAgent } from './resolve-turn-agent';

function fakeConfig(agentId: string): PublishedAgentConfig {
  return {
    agentId,
    versionId: `v-${agentId}`,
    agentName: agentId,
    systemPrompt: 'prompt',
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    credentialId: null,
    maxSteps: 5,
    historyMessageWindow: 20,
    historyTokenWindow: 4000,
    handoffKeywords: [],
    handoffToolEnabled: false,
    proposalAiDraftEnabled: true,
    splitMessages: false,
    splitMaxChars: 900,
    inboundDebounceMs: null,
    replyMinIntervalMs: null,
    multimodalInput: false,
    casesEnabled: false,
    toolIds: [],
    knowledgeSourceIds: [],
    skillNames: null,
    activeKbVersionId: null,
    ragTopK: 5,
    ragSimilarityThreshold: 0.72,
    janelaDeAtendimento: null,
    versionCreatedBy: null,
    operatorEnabled: false,
    operatorModel: null,
    operatorToolIds: [],
    pipelineIds: [],
    agentCreatedBy: null,
    vozEnabled: false,
    vozQuando: 'espelhar',
  };
}

/** A reserva do roteador é o agente A, que também é membro da intenção "vendas". */
const members = [
  { agentId: 'agent-a', intentName: 'vendas', intentDescription: 'quer comprar', examples: [] },
  { agentId: 'agent-b', intentName: 'suporte', intentDescription: 'problema técnico', examples: [] },
];

function router(overrides: Partial<LoadedRouter> = {}): LoadedRouter {
  return {
    id: 'router-1',
    name: 'R',
    classifierModel: 'claude-haiku-4-5',
    classifierProvider: null,
    sticky: true,
    minConfidence: 0.6,
    fallbackAgentId: 'agent-a',
    members,
    ...overrides,
  };
}

const baseInput = {
  tenantId: 'org-1',
  leadId: 'lead-1',
  jobId: 'job-1',
  channelSessionId: 'sess-1',
  conversationId: 'conv-1',
};

function deps(opts: {
  classify: ReturnType<typeof vi.fn>;
  registrarDecisao?: ReturnType<typeof vi.fn>;
}) {
  return {
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    loadActiveRouter: vi.fn().mockResolvedValue(router()),
    loadPublishedAgentConfigById: vi.fn(async (_db: unknown, _org: unknown, id: string) => fakeConfig(id)),
    loadPublishedAgentConfig: vi.fn(async (_db: unknown, _org: unknown) => fakeConfig('agent-a')),
    classifyIntent: opts.classify,
    carregarFatosDoCrmDoContato: vi.fn().mockResolvedValue({
      fatos: { funis: [], etiquetas: [], funisOmitidos: 0, etiquetasOmitidas: 0 }, motivo: null,
    }),
    consultarJev: vi.fn(() => ({
      estado: Promise.resolve('desligada'),
      escolha: Promise.resolve(null),
      modo: Promise.resolve('comparacao'),
      observar: vi.fn(),
    })),
    temIaDeSempre: vi.fn().mockResolvedValue(true),
    registrarDecisao: opts.registrarDecisao ?? vi.fn().mockResolvedValue(undefined),
  } as never;
}

const contexto = { contact: { name: 'Cliente', email: null }, messages: [] } as never;

describe('#4679 — a passagem automática não reapresenta o mesmo agente', () => {
  it('reclassificação para o MESMO agente não gera segunda apresentação (fallback → sticky → reclassified)', async () => {
    // Turno 1 — saudação sem intenção confiável: reserva A atende, A se apresenta.
    const turno1 = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: 'Boa tarde', stickyAgentId: null, stickyIntent: null },
      deps({ classify: vi.fn().mockResolvedValue({ intentName: null, confidence: 0 }) }));
    expect(turno1.outcome).toBe('fallback');
    expect(turno1.config?.agentId).toBe('agent-a');
    expect(turno1.passagemRecebida).toBeUndefined();

    // Turno 2 — também sem intenção clara: sticky sem intenção (stickyIntent null).
    const turno2 = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: 'Tudo bem?', stickyAgentId: 'agent-a', stickyIntent: null },
      deps({ classify: vi.fn().mockResolvedValue({ intentName: null, confidence: 0 }) }));
    expect(turno2.outcome).toBe('sticky');
    expect(turno2.config?.agentId).toBe('agent-a');
    expect(turno2.passagemRecebida).toBeUndefined();

    // Turno 3 — o classificador casa "vendas", a intenção do PRÓPRIO A.
    // O outcome continua `reclassified` (é o que a telemetria registra), mas
    // não há troca de agente: nada de segunda apresentação.
    const registrarDecisao = vi.fn().mockResolvedValue(undefined);
    const turno3 = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: 'que tipo de consulta vocês oferecem?', stickyAgentId: 'agent-a', stickyIntent: null },
      deps({ classify: vi.fn().mockResolvedValue({ intentName: 'vendas', confidence: 0.9 }), registrarDecisao }));
    expect(turno3.outcome).toBe('reclassified');
    expect(turno3.config?.agentId).toBe('agent-a');
    // A classificação gravada é a mesma: não mexemos no roteador nem no `outcome`.
    expect(registrarDecisao.mock.calls[0]![1]).toMatchObject({
      resultado: { outcome: 'reclassified' },
    });
    // O ponto do defeito: sem passagem, não existe bloco de passagem no prompt.
    expect(turno3.passagemRecebida).toBeUndefined();
    const bloco = montarBlocoDePassagemDoRoteador(turno3.passagemRecebida);
    expect(bloco).toBe('');
    const prompt = buildOpeningMessage(null, null, contexto, '—', false, [], '', undefined, undefined, undefined, undefined, bloco);
    expect(prompt).not.toContain(TITULO_DO_BLOCO_DE_PASSAGEM);
    expect(prompt).not.toMatch(/Apresente-se ao cliente pelo seu nome/);
  });

  it('reclassificação para agente DIFERENTE gera a apresentação de passagem (controle positivo)', async () => {
    const out = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: 'na verdade tenho um problema técnico', stickyAgentId: 'agent-a', stickyIntent: 'vendas' },
      deps({ classify: vi.fn().mockResolvedValue({ intentName: 'suporte', confidence: 0.8 }) }));
    expect(out.outcome).toBe('reclassified');
    expect(out.config?.agentId).toBe('agent-b');
    // Troca REAL: de A para B — e aí a passagem é devida, com o agente certo.
    expect(out.passagemRecebida).toEqual({ agenteAnteriorId: 'agent-a', agenteAnteriorNome: 'agent-a' });
    const blocoAnterior = montarBlocoDePassagemDoRoteador(out.passagemRecebida);
    expect(blocoAnterior).toContain(TITULO_DO_BLOCO_DE_PASSAGEM);
    expect(blocoAnterior).toMatch(/Apresente-se ao cliente pelo seu nome/);
    const prompt = buildOpeningMessage(null, null, contexto, '—', false, [], '', undefined, undefined, undefined, undefined, blocoAnterior);
    expect(prompt).toContain(TITULO_DO_BLOCO_DE_PASSAGEM);
  });

  it('primeira mensagem continua apresentando: nenhum bloco suprime a apresentação inicial', async () => {
    const out = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: 'quanto custa?', stickyAgentId: null, stickyIntent: null },
      deps({ classify: vi.fn().mockResolvedValue({ intentName: 'vendas', confidence: 0.9 }) }));
    expect(out.outcome).toBe('classified');
    expect(out.config?.agentId).toBe('agent-a');
    expect(out.passagemRecebida).toBeUndefined();
    const bloco = montarBlocoDePassagemDoRoteador(out.passagemRecebida);
    expect(bloco).toBe('');
    const prompt = buildOpeningMessage(null, null, contexto, '—', false, [], '', undefined, undefined, undefined, undefined, bloco);
    // Primeiro turno de verdade: a conversa nasce aqui, e o agente segue o
    // próprio prompt (que manda se apresentar). O conserto não injeta nada.
    expect(prompt).toContain('primeiro turno — sem checkpoint anterior');
    expect(prompt).not.toContain(TITULO_DO_BLOCO_DE_PASSAGEM);
    expect(prompt).not.toMatch(/NÃO se apresente/);
    // A outra metade da apresentação inicial: o gate de disclosure continua
    // exigindo que a 1ª mensagem a um lead novo se apresente. Nada nesta fatia
    // o afrouxa — e é ele que garante a apresentação do primeiro turno.
    const template = 'Sou a assistente virtual da Loja Exemplo.';
    const ctxDoGate = (body: string) =>
      ({ body, disclosure: { template, isFirstOutbound: true, mode: 'veto' } }) as never;
    expect(disclosureGate.evaluate(ctxDoGate('Temos três planos disponíveis.')))
      .toMatchObject({ pass: false, code: 'disclosure_required' });
    expect(disclosureGate.evaluate(ctxDoGate(`${template} Temos três planos disponíveis.`)))
      .toMatchObject({ pass: true });
  });

  it('sticky sem intenção não apresenta de novo', async () => {
    // Sem veredito nenhum: o classificador não devolveu intenção.
    const semVeredito = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: 'hmm', stickyAgentId: 'agent-a', stickyIntent: null },
      deps({ classify: vi.fn().mockResolvedValue({ intentName: null, confidence: 0 }) }));
    expect(semVeredito.outcome).toBe('sticky');
    expect(semVeredito.config?.agentId).toBe('agent-a');
    expect(semVeredito.passagemRecebida).toBeUndefined();

    // Veredito abaixo do mínimo: continua sticky, continua sem passagem.
    const baixaConfianca = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: 'acho que talvez', stickyAgentId: 'agent-a', stickyIntent: null },
      deps({ classify: vi.fn().mockResolvedValue({ intentName: 'vendas', confidence: 0.3 }) }));
    expect(baixaConfianca.outcome).toBe('sticky');
    expect(baixaConfianca.config?.agentId).toBe('agent-a');
    expect(baixaConfianca.passagemRecebida).toBeUndefined();
    expect(montarBlocoDePassagemDoRoteador(baixaConfianca.passagemRecebida)).toBe('');
  });
});
