import { describe, expect, it, vi } from 'vitest';

import { resolveTurnAgent } from './resolve-turn-agent';
import type { PublishedAgentConfig } from './agent-config';
import type { LoadedRouter } from './router-config';

/** Config mínima válida — só o agentId importa pros testes (identidade). */
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
    splitMessages: false,
    splitMaxChars: 900,
    multimodalInput: false,
    casesEnabled: false,
    toolIds: [],
    activeKbVersionId: null,
    ragTopK: 5,
    ragSimilarityThreshold: 0.72,
    janelaDeAtendimento: null,
    versionCreatedBy: null,
    operatorEnabled: false,
  operatorModel: null,
  operatorToolIds: [], pipelineIds: [],
  agentCreatedBy: null,
  };
}

const members = [
  { agentId: 'agent-vendas', intentName: 'vendas', intentDescription: 'quer comprar', examples: [] },
  { agentId: 'agent-suporte', intentName: 'suporte', intentDescription: 'problema técnico', examples: [] },
];

function router(overrides: Partial<LoadedRouter> = {}): LoadedRouter {
  return {
    id: 'router-1',
    name: 'R',
    classifierModel: 'claude-haiku-4-5',
    classifierProvider: null,
    sticky: true,
    minConfidence: 0.6,
    fallbackAgentId: null,
    members,
    ...overrides,
  };
}

/** Mock que devolve o config do ID pedido — id fixo mascararia bug de "carregou o agente errado" (review T4 finding 2). */
function idAwareLoader() {
  return vi.fn(async (_db: unknown, _org: unknown, id: string) => fakeConfig(id));
}

const baseInput = {
  tenantId: 'org-1',
  leadId: 'lead-1',
  jobId: 'job-1',
  channelSessionId: 'sess-1',
  conversationId: 'conv-1',
};

function makeDeps(overrides: {
  loadActiveRouter?: ReturnType<typeof vi.fn>;
  loadPublishedAgentConfigById?: ReturnType<typeof vi.fn>;
  loadPublishedAgentConfig?: ReturnType<typeof vi.fn>;
  classifyIntent?: ReturnType<typeof vi.fn>;
}) {
  return {
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    loadActiveRouter: overrides.loadActiveRouter ?? vi.fn(),
    loadPublishedAgentConfigById: overrides.loadPublishedAgentConfigById ?? vi.fn(),
    loadPublishedAgentConfig: overrides.loadPublishedAgentConfig ?? vi.fn(),
    classifyIntent: overrides.classifyIntent ?? vi.fn(),
  } as never;
}

describe('resolveTurnAgent', () => {
  it('1. canal sem router → no_router, usa loadPublishedAgentConfig por sessão', async () => {
    const loadActiveRouter = vi.fn().mockResolvedValue(null);
    const loadPublishedAgentConfig = vi.fn().mockResolvedValue(fakeConfig('agent-sessao'));
    const classifyIntent = vi.fn();
    const out = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: 'oi', stickyAgentId: null, stickyIntent: null },
      makeDeps({ loadActiveRouter, loadPublishedAgentConfig, classifyIntent }));
    expect(out.outcome).toBe('no_router');
    expect(out.config?.agentId).toBe('agent-sessao');
    expect(out.routerId).toBeNull();
    expect(classifyIntent).not.toHaveBeenCalled();
  });

  it('2. router + classificação alta confiança → classified, config do agente da intenção', async () => {
    const r = router({ sticky: false });
    const loadActiveRouter = vi.fn().mockResolvedValue(r);
    const classifyIntent = vi.fn().mockResolvedValue({ intentName: 'vendas', confidence: 0.9 });
    const loadPublishedAgentConfigById = idAwareLoader();
    const out = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: 'quanto custa?', stickyAgentId: null, stickyIntent: null },
      makeDeps({ loadActiveRouter, classifyIntent, loadPublishedAgentConfigById }));
    expect(out.outcome).toBe('classified');
    expect(out.config?.agentId).toBe('agent-vendas');
    expect(out.intentName).toBe('vendas');
    expect(out.confidence).toBe(0.9);
  });

  it('3. sticky + mesma intenção → sticky, NÃO troca de agente', async () => {
    const r = router();
    const loadActiveRouter = vi.fn().mockResolvedValue(r);
    const classifyIntent = vi.fn().mockResolvedValue({ intentName: 'vendas', confidence: 0.9 });
    const loadPublishedAgentConfigById = idAwareLoader();
    const out = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: 'mais uma pergunta sobre preço', stickyAgentId: 'agent-vendas', stickyIntent: 'vendas' },
      makeDeps({ loadActiveRouter, classifyIntent, loadPublishedAgentConfigById }));
    expect(out.outcome).toBe('sticky');
    expect(out.config?.agentId).toBe('agent-vendas');
    expect(loadPublishedAgentConfigById).toHaveBeenCalledWith({}, 'org-1', 'agent-vendas');
  });

  it('4. sticky + intenção diferente com confiança >= min → reclassified, troca de agente', async () => {
    const r = router();
    const loadActiveRouter = vi.fn().mockResolvedValue(r);
    const classifyIntent = vi.fn().mockResolvedValue({ intentName: 'suporte', confidence: 0.8 });
    const loadPublishedAgentConfigById = idAwareLoader();
    const out = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: 'na verdade tenho um problema técnico', stickyAgentId: 'agent-vendas', stickyIntent: 'vendas' },
      makeDeps({ loadActiveRouter, classifyIntent, loadPublishedAgentConfigById }));
    expect(out.outcome).toBe('reclassified');
    expect(out.config?.agentId).toBe('agent-suporte');
    expect(out.intentName).toBe('suporte');
  });

  it('5. sticky + intenção diferente com confiança ABAIXO do min → sticky (não troca)', async () => {
    const r = router();
    const loadActiveRouter = vi.fn().mockResolvedValue(r);
    const classifyIntent = vi.fn().mockResolvedValue({ intentName: 'suporte', confidence: 0.4 });
    const loadPublishedAgentConfigById = idAwareLoader();
    const out = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: 'hmm será que...', stickyAgentId: 'agent-vendas', stickyIntent: 'vendas' },
      makeDeps({ loadActiveRouter, classifyIntent, loadPublishedAgentConfigById }));
    expect(out.outcome).toBe('sticky');
    expect(out.config?.agentId).toBe('agent-vendas');
  });

  it('6. classificador falhou (null) + fallback configurado → classifier_failed, config do fallback', async () => {
    const r = router({ sticky: false, fallbackAgentId: 'agent-fallback' });
    const loadActiveRouter = vi.fn().mockResolvedValue(r);
    const classifyIntent = vi.fn().mockResolvedValue(null);
    const loadPublishedAgentConfigById = idAwareLoader();
    const out = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: 'algo incompreensível', stickyAgentId: null, stickyIntent: null },
      makeDeps({ loadActiveRouter, classifyIntent, loadPublishedAgentConfigById }));
    expect(out.outcome).toBe('classifier_failed');
    expect(out.config?.agentId).toBe('agent-fallback');
  });

  it('7. sem match + SEM fallback → no_match, mas atende o agente PUBLICADO DA SESSÃO', async () => {
    const r = router({ sticky: false, fallbackAgentId: null });
    const loadActiveRouter = vi.fn().mockResolvedValue(r);
    const classifyIntent = vi.fn().mockResolvedValue({ intentName: null, confidence: 0.1 });
    const loadPublishedAgentConfigById = vi.fn();
    const loadPublishedAgentConfig = vi.fn().mockResolvedValue(fakeConfig('agent-da-sessao'));
    const out = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: 'blablabla', stickyAgentId: null, stickyIntent: null },
      makeDeps({ loadActiveRouter, classifyIntent, loadPublishedAgentConfigById, loadPublishedAgentConfig }));
    // O outcome continua contando a verdade (o router não casou nada)...
    expect(out.outcome).toBe('no_match');
    // ...mas quem responde é quem responderia sem router — nunca o genérico.
    expect(out.config?.agentId).toBe('agent-da-sessao');
    expect(loadPublishedAgentConfigById).not.toHaveBeenCalled();
  });

  it('8. signal null (follow-up) → nunca chama classifyIntent; usa sticky se houver', async () => {
    const r = router();
    const loadActiveRouter = vi.fn().mockResolvedValue(r);
    const classifyIntent = vi.fn();
    const loadPublishedAgentConfigById = idAwareLoader();
    const out = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: null, stickyAgentId: 'agent-vendas', stickyIntent: 'vendas' },
      makeDeps({ loadActiveRouter, classifyIntent, loadPublishedAgentConfigById }));
    expect(classifyIntent).not.toHaveBeenCalled();
    expect(out.outcome).toBe('sticky');
    expect(out.config?.agentId).toBe('agent-vendas');
  });

  it('9. erro inesperado no router (ex.: DB fora do ar) nunca derruba o turno — cai no loadPublishedAgentConfig atual', async () => {
    const loadActiveRouter = vi.fn().mockRejectedValue(new Error('db timeout'));
    const loadPublishedAgentConfig = vi.fn().mockResolvedValue(fakeConfig('agent-sessao'));
    const out = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: 'oi', stickyAgentId: null, stickyIntent: null },
      makeDeps({ loadActiveRouter, loadPublishedAgentConfig }));
    expect(out.outcome).toBe('classifier_failed');
    expect(out.config?.agentId).toBe('agent-sessao');
  });

  it('10. sticky + classificador devolve null → mantém o agente sticky (review T4 finding 1)', async () => {
    const r = router();
    const loadActiveRouter = vi.fn().mockResolvedValue(r);
    const classifyIntent = vi.fn().mockResolvedValue(null);
    const loadPublishedAgentConfigById = idAwareLoader();
    const out = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: 'timeout do classificador não pode trocar quem atende', stickyAgentId: 'agent-vendas', stickyIntent: 'vendas' },
      makeDeps({ loadActiveRouter, classifyIntent, loadPublishedAgentConfigById }));
    expect(out.outcome).toBe('sticky');
    expect(out.config?.agentId).toBe('agent-vendas');
  });

  it('11. classificou, confiança baixa, MAS existe fallback → outcome fallback (sem cobertura antes — finding 3)', async () => {
    const r = router({ sticky: false, fallbackAgentId: 'agent-fallback' });
    const loadActiveRouter = vi.fn().mockResolvedValue(r);
    const classifyIntent = vi.fn().mockResolvedValue({ intentName: 'vendas', confidence: 0.2 });
    const loadPublishedAgentConfigById = idAwareLoader();
    const out = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: 'talvez eu queira comprar', stickyAgentId: null, stickyIntent: null },
      makeDeps({ loadActiveRouter, classifyIntent, loadPublishedAgentConfigById }));
    expect(out.outcome).toBe('fallback');
    expect(out.config?.agentId).toBe('agent-fallback');
  });

  it('12. signal null, SEM sticky, COM fallback → outcome fallback (regra 6, ramo sem cobertura)', async () => {
    const r = router({ sticky: false, fallbackAgentId: 'agent-fallback' });
    const loadActiveRouter = vi.fn().mockResolvedValue(r);
    const classifyIntent = vi.fn();
    const loadPublishedAgentConfigById = idAwareLoader();
    const out = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: null, stickyAgentId: null, stickyIntent: null },
      makeDeps({ loadActiveRouter, classifyIntent, loadPublishedAgentConfigById }));
    expect(classifyIntent).not.toHaveBeenCalled();
    expect(out.outcome).toBe('fallback');
    expect(out.config?.agentId).toBe('agent-fallback');
  });

  it('13. agente casado (classificado) sem versão publicada → cai no fallback do router, outcome honesto (finding 4)', async () => {
    const r = router({ sticky: false, fallbackAgentId: 'agent-fallback' });
    const loadActiveRouter = vi.fn().mockResolvedValue(r);
    const classifyIntent = vi.fn().mockResolvedValue({ intentName: 'vendas', confidence: 0.9 });
    // agent-vendas (o casado) não tem versão publicada; agent-fallback tem.
    const loadPublishedAgentConfigById = vi.fn(async (_db: unknown, _org: unknown, id: string) =>
      id === 'agent-vendas' ? null : fakeConfig(id));
    const warn = vi.fn();
    const out = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: 'quanto custa?', stickyAgentId: null, stickyIntent: null },
      { log: { info: vi.fn(), warn, error: vi.fn() }, loadActiveRouter, classifyIntent, loadPublishedAgentConfigById } as never);
    // NUNCA outcome 'classified' com config null — telemetria não pode mentir.
    expect(out.outcome).toBe('fallback');
    expect(out.config?.agentId).toBe('agent-fallback');
    expect(warn).toHaveBeenCalled();
  });

  it('14. agente casado E o fallback também sem versão publicada → config null, outcome honesto no_match (fim legítimo da linha)', async () => {
    const r = router({ sticky: false, fallbackAgentId: 'agent-fallback' });
    const loadActiveRouter = vi.fn().mockResolvedValue(r);
    const classifyIntent = vi.fn().mockResolvedValue({ intentName: 'vendas', confidence: 0.9 });
    const loadPublishedAgentConfigById = vi.fn().mockResolvedValue(null);
    const out = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: 'quanto custa?', stickyAgentId: null, stickyIntent: null },
      makeDeps({ loadActiveRouter, classifyIntent, loadPublishedAgentConfigById }));
    expect(out.outcome).toBe('no_match');
    expect(out.config).toBeNull();
  });

  it('15. router ATIVO, ZERO membros e sem fallback NÃO sequestra a sessão (defeito medido 2026-08-18)', async () => {
    // Estado que a tela deixa criar em dois cliques: roteador ligado, nenhum
    // membro, nenhum fallback. Ele não classifica nada por construção — e antes
    // deste conserto derrubava TODA mensagem do número para o agente genérico,
    // que na instalação medida não tinha credencial: job morto, silêncio total
    // com a tela dizendo "IA atendendo".
    const r = router({ sticky: false, members: [], fallbackAgentId: null });
    const loadActiveRouter = vi.fn().mockResolvedValue(r);
    const classifyIntent = vi.fn().mockResolvedValue(null);
    const loadPublishedAgentConfig = vi.fn().mockResolvedValue(fakeConfig('agent-publicado'));
    const out = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: 'Oi', stickyAgentId: null, stickyIntent: null },
      makeDeps({ loadActiveRouter, classifyIntent, loadPublishedAgentConfig }));
    expect(out.config?.agentId).toBe('agent-publicado');
    expect(out.outcome).toBe('classifier_failed');
  });

  it('16. router sem fallback E sessão sem agente publicado → config null (genérico) com aviso', async () => {
    const r = router({ sticky: false, fallbackAgentId: null });
    const loadActiveRouter = vi.fn().mockResolvedValue(r);
    const classifyIntent = vi.fn().mockResolvedValue({ intentName: null, confidence: 0.1 });
    const loadPublishedAgentConfig = vi.fn().mockResolvedValue(null);
    const warn = vi.fn();
    const out = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: 'blablabla', stickyAgentId: null, stickyIntent: null },
      { log: { info: vi.fn(), warn, error: vi.fn() }, loadActiveRouter, classifyIntent, loadPublishedAgentConfig } as never);
    expect(out.config).toBeNull();
    expect(out.outcome).toBe('no_match');
    expect(warn).toHaveBeenCalled();
  });
});
