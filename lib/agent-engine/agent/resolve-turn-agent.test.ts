import { describe, expect, it, vi } from 'vitest';

import type { EstadoDaTarefa } from '@/lib/ai/decisao/config';
import type { EscolhaDoJev, JevNoRoteador } from '@/lib/ai/decisao/roteador';

import { agenteDoDestino, destinoDoVeredito, resolveConversationTurn, resolveTurnAgent } from './resolve-turn-agent';
import type { PublishedAgentConfig } from './agent-config';
import type { IntentVerdict } from './intent-classifier';
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
    knowledgeSourceIds: [],
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

/**
 * O Jev no roteador, de mentira: o estado da tarefa e a escolha dele, cada um
 * uma promessa que o teste controla. Por padrão, desligado — o roteamento de
 * sempre, que é o que os casos 1 a 16 medem.
 */
function jevFalso(estado: EstadoDaTarefa = 'desligada', escolha: Promise<EscolhaDoJev | null> = Promise.resolve(null)) {
  const jev = { estado: Promise.resolve(estado), escolha, observar: vi.fn<JevNoRoteador['observar']>() };
  return { jev, consultarJev: vi.fn((): JevNoRoteador => jev) };
}

function makeDeps(overrides: {
  loadActiveRouter?: ReturnType<typeof vi.fn>;
  loadPublishedAgentConfigById?: ReturnType<typeof vi.fn>;
  loadPublishedAgentConfig?: ReturnType<typeof vi.fn>;
  classifyIntent?: ReturnType<typeof vi.fn>;
  consultarJev?: ReturnType<typeof vi.fn>;
}) {
  return {
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    loadActiveRouter: overrides.loadActiveRouter ?? vi.fn(),
    loadPublishedAgentConfigById: overrides.loadPublishedAgentConfigById ?? vi.fn(),
    loadPublishedAgentConfig: overrides.loadPublishedAgentConfig ?? vi.fn(),
    classifyIntent: overrides.classifyIntent ?? vi.fn(),
    consultarJev: overrides.consultarJev ?? jevFalso().consultarJev,
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

  it('roteiro do membro: começa na intenção casada agora, nunca no sticky', async () => {
    const comRoteiro = [
      { ...members[0]!, flowPointerId: 'roteiro-vendas' },
      { ...members[1]!, flowPointerId: 'roteiro-suporte' },
    ];
    const loadPublishedAgentConfigById = idAwareLoader();
    const classificado = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: 'quanto custa?', stickyAgentId: null, stickyIntent: null },
      makeDeps({
        loadActiveRouter: vi.fn().mockResolvedValue(router({ sticky: false, members: comRoteiro })),
        classifyIntent: vi.fn().mockResolvedValue({ intentName: 'vendas', confidence: 0.9 }),
        loadPublishedAgentConfigById,
      }));
    expect(classificado.outcome).toBe('classified');
    expect(classificado.flowPointerId).toBe('roteiro-vendas');

    const sticky = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: 'e o preço?', stickyAgentId: 'agent-vendas', stickyIntent: 'vendas' },
      makeDeps({
        loadActiveRouter: vi.fn().mockResolvedValue(router({ members: comRoteiro })),
        classifyIntent: vi.fn().mockResolvedValue({ intentName: 'vendas', confidence: 0.9 }),
        loadPublishedAgentConfigById,
      }));
    expect(sticky.outcome).toBe('sticky');
    expect(sticky.flowPointerId).toBeNull();
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

describe('resolveConversationTurn — contexto curto do classificador', () => {
  /** Banco falso por consulta: conversa com agente fixo, a última inbound e o contexto (mais recente primeiro, como o SQL devolve). */
  function fakeDb(signalRow: { id: string; body: string | null } | null, contextoDesc: { direction: string; body: string }[]) {
    return {
      query: vi.fn(async (sql: string, _values: unknown[]) => {
        if (sql.includes('from conversations')) return { rows: [{ active_ai_agent_id: 'agent-vendas', active_intent: 'vendas' }] };
        if (sql.includes('id<>$3')) return { rows: contextoDesc };
        return { rows: signalRow ? [signalRow] : [] };
      }),
    };
  }
  function deps() {
    const classifyIntent = vi.fn().mockResolvedValue({ intentName: 'vendas', confidence: 0.9 });
    return {
      classifyIntent,
      deps: makeDeps({
        loadActiveRouter: vi.fn().mockResolvedValue(router()),
        loadPublishedAgentConfigById: idAwareLoader(),
        classifyIntent,
      }),
    };
  }

  it('passa ao classificador as mensagens anteriores em ordem cronológica, sem a atual, recortadas pela organização', async () => {
    const db = fakeDb({ id: 'msg-atual', body: 'Primeira' }, [
      { direction: 'outbound', body: 'Qual data prefere: a primeira ou a segunda?' },
      { direction: 'inbound', body: 'Quero marcar uma consulta' },
    ]);
    const { classifyIntent, deps: d } = deps();
    const out = await resolveConversationTurn(db as never, {} as never, { ...baseInput, inbound: true }, d);

    expect(out.outcome).toBe('sticky');
    const [sql, values] = db.query.mock.calls.find(([q]) => q.includes('id<>$3'))!;
    expect(sql).toContain('organization_id=$1 and conversation_id=$2');
    expect(values).toEqual(['org-1', 'conv-1', 'msg-atual', 4]);
    expect(classifyIntent.mock.calls[0]![2]).toMatchObject({
      signal: 'Primeira',
      recentMessages: [
        { direction: 'inbound', body: 'Quero marcar uma consulta' },
        { direction: 'outbound', body: 'Qual data prefere: a primeira ou a segunda?' },
      ],
    });
  });

  it('sem inbound (follow-up) não consulta contexto nem classifica', async () => {
    const db = fakeDb(null, []);
    const { classifyIntent, deps: d } = deps();
    await resolveConversationTurn(db as never, {} as never, { ...baseInput, inbound: false }, d);
    // Afirma o que o título promete — nenhuma leitura de `messages`, nem a do
    // signal nem a do contexto — em vez de CONTAR consultas. A contagem era um
    // atalho que media o resto do turno junto: o degrau 0 de campanha (#1392)
    // lê `campaign_recipients` em todo turno, por projeto, e derrubou este caso
    // sem que nada do que ele guarda tivesse mudado. A forma abaixo é a mesma
    // do caso de mídia, logo adiante.
    expect(db.query.mock.calls.some(([q]) => q.includes('from messages'))).toBe(false);
    expect(classifyIntent).not.toHaveBeenCalled();
  });

  it('inbound sem texto (mídia) não consulta contexto: o classificador nem roda', async () => {
    const db = fakeDb({ id: 'msg-audio', body: null }, []);
    const { classifyIntent, deps: d } = deps();
    await resolveConversationTurn(db as never, {} as never, { ...baseInput, inbound: true }, d);
    expect(db.query.mock.calls.some(([q]) => q.includes('id<>$3'))).toBe(false);
    expect(classifyIntent).not.toHaveBeenCalled();
  });
});

function escolha(intentName: string | null, confidence: number, estado: 'observando' | 'decidindo'): EscolhaDoJev {
  return {
    estado,
    veredito: { intentName, confidence },
    confianca: 0.9,
    modelo: 'jev-1.13.0',
    tokensDeEntrada: 400,
    tokensDeSaida: 3,
    latenciaMs: 300,
  };
}

/** Uma promessa que só resolve quando o teste manda — o Jev lento. */
function adiada<T>() {
  let resolver!: (v: T) => void;
  const promessa = new Promise<T>((r) => {
    resolver = r;
  });
  return { promessa, resolver };
}

describe('o Jev no roteador (onda 2 do Jev, bloco 2.2)', () => {
  const semSticky = { ...baseInput, signal: 'meu pedido não chegou', stickyAgentId: null, stickyIntent: null };

  async function rodar(opts: {
    daIa: IntentVerdict | null;
    jev: ReturnType<typeof jevFalso>;
    entrada?: Parameters<typeof resolveTurnAgent>[2];
    r?: LoadedRouter;
  }) {
    const classifyIntent = vi.fn().mockResolvedValue(opts.daIa);
    const out = await resolveTurnAgent({} as never, {} as never, opts.entrada ?? semSticky, makeDeps({
      loadActiveRouter: vi.fn().mockResolvedValue(opts.r ?? router({ fallbackAgentId: 'agent-reserva' })),
      loadPublishedAgentConfigById: idAwareLoader(),
      classifyIntent,
      consultarJev: opts.jev.consultarJev,
    }));
    return { out, classifyIntent };
  }

  it('pergunta EM PARALELO: o Jev começa antes de a IA de sempre responder, com a mensagem sozinha', async () => {
    const jev = jevFalso('observando');
    const classifyIntent = vi.fn(async () => {
      // A IA de sempre ainda não respondeu, e o Jev já foi perguntado.
      expect(jev.consultarJev).toHaveBeenCalledOnce();
      return { intentName: 'vendas', confidence: 0.9 };
    });
    await resolveTurnAgent({} as never, {} as never, { ...semSticky, recentMessages: [{ direction: 'outbound', body: 'contexto' }] }, makeDeps({
      loadActiveRouter: vi.fn().mockResolvedValue(router()),
      loadPublishedAgentConfigById: idAwareLoader(),
      classifyIntent,
      consultarJev: jev.consultarJev,
    }));
    expect(classifyIntent).toHaveBeenCalledOnce();
    const [, entrada] = jev.consultarJev.mock.calls[0]! as unknown as [unknown, Record<string, unknown>];
    // R4: só a última mensagem — o contexto das 4 anteriores fica com a IA de sempre.
    expect(entrada).toEqual({
      organizationId: 'org-1',
      mensagem: 'meu pedido não chegou',
      membros: members,
      contactId: 'lead-1',
      jobId: 'job-1',
    });
  });

  it('observando: o turno NÃO espera o Jev — vale a IA de sempre, e a observação sai quando ele responder', async () => {
    const lento = adiada<EscolhaDoJev | null>();
    const jev = jevFalso('observando', lento.promessa);
    // Se o turno esperasse o Jev, este await nunca voltaria: a escolha só
    // resolve DEPOIS dele.
    const { out } = await rodar({ daIa: { intentName: 'vendas', confidence: 0.9 }, jev });
    expect(out.outcome).toBe('classified');
    expect(out.config?.agentId).toBe('agent-vendas');
    expect(jev.jev.observar).toHaveBeenCalledOnce();
    expect(jev.jev.observar.mock.calls[0]![0]).toMatchObject({
      vereditoDaIa: { intentName: 'vendas', confidence: 0.9 },
      decidiu: false,
      aIaCobriu: false,
      conversationId: 'conv-1',
    });
    lento.resolver(escolha('suporte', 0.95, 'observando'));
  });

  it('decidindo: vale a escolha do Jev, com o min_confidence sobre a probabilidade dele', async () => {
    const jev = jevFalso('decidindo', Promise.resolve(escolha('suporte', 0.8, 'decidindo')));
    const { out } = await rodar({ daIa: { intentName: 'vendas', confidence: 0.95 }, jev });
    expect(out.outcome).toBe('classified');
    expect(out.config?.agentId).toBe('agent-suporte');
    expect(out.intentName).toBe('suporte');
    expect(out.confidence).toBe(0.8);
    expect(jev.jev.observar.mock.calls[0]![0]).toMatchObject({ decidiu: true });
  });

  it('decidindo, com a probabilidade dele ABAIXO do mínimo: o de reserva — a régua é a mesma da IA de sempre', async () => {
    const jev = jevFalso('decidindo', Promise.resolve(escolha('suporte', 0.4, 'decidindo')));
    const { out } = await rodar({ daIa: { intentName: 'vendas', confidence: 0.95 }, jev });
    expect(out.outcome).toBe('fallback');
    expect(out.config?.agentId).toBe('agent-reserva');
  });

  it('decidindo, e o Jev sem resposta: a IA de sempre é a reserva', async () => {
    const jev = jevFalso('decidindo', Promise.resolve(null));
    const { out } = await rodar({ daIa: { intentName: 'vendas', confidence: 0.95 }, jev });
    expect(out.config?.agentId).toBe('agent-vendas');
    // A cobertura deixa rastro: é ela que o cartão conta.
    expect(jev.jev.observar.mock.calls[0]![0]).toMatchObject({ decidiu: false, aIaCobriu: true });
  });

  describe('R2 — sem a IA de sempre, vale a regra de hoje, NUNCA o Jev', () => {
    it('sem sticky: classifier_failed, o de reserva — e o turno nem espera o Jev', async () => {
      const lento = adiada<EscolhaDoJev | null>();
      const jev = jevFalso('decidindo', lento.promessa);
      const { out } = await rodar({ daIa: null, jev });
      expect(out.outcome).toBe('classifier_failed');
      expect(out.config?.agentId).toBe('agent-reserva');
      // Sem a IA de sempre ninguém cobriu nada: valeu a regra de hoje.
      expect(jev.jev.observar.mock.calls[0]![0]).toMatchObject({ vereditoDaIa: null, decidiu: false, aIaCobriu: false });
      lento.resolver(escolha('suporte', 0.99, 'decidindo'));
    });

    it('com sticky: segue o agente de antes, mesmo com o Jev decidindo e certo de outra intenção', async () => {
      const jev = jevFalso('decidindo', Promise.resolve(escolha('suporte', 0.99, 'decidindo')));
      const { out } = await rodar({
        daIa: null,
        jev,
        entrada: { ...semSticky, stickyAgentId: 'agent-vendas', stickyIntent: 'vendas' },
      });
      expect(out.outcome).toBe('sticky');
      expect(out.config?.agentId).toBe('agent-vendas');
    });

    // A saída ilegível da IA (`parseIntentVerdict` marca `falhou`) não é
    // resposta: um modelo que nunca devolve JSON deixava o Jev rotear sozinho,
    // sem alarme — o contrário da manipulação, que já lia o lixo como falha.
    it('a IA de sempre responde lixo: é falha — decidindo vale a regra de hoje, e não o Jev', async () => {
      const jev = jevFalso('decidindo', Promise.resolve(escolha('suporte', 0.8, 'decidindo')));
      const { out } = await rodar({ daIa: { intentName: null, confidence: 0, falhou: true }, jev });
      // O lixo segue "nenhuma" para o roteamento de hoje: sem sticky, o de reserva.
      expect(out.config?.agentId).toBe('agent-reserva');
      expect(out.outcome).toBe('fallback');
      expect(jev.jev.observar.mock.calls[0]![0]).toMatchObject({ vereditoDaIa: null, decidiu: false });
    });

    it('controle: a IA diz "nenhuma" de verdade — é resposta, e decidindo vale o Jev', async () => {
      const jev = jevFalso('decidindo', Promise.resolve(escolha('suporte', 0.8, 'decidindo')));
      const { out } = await rodar({ daIa: { intentName: null, confidence: 0.7 }, jev });
      expect(out.config?.agentId).toBe('agent-suporte');
      expect(jev.jev.observar.mock.calls[0]![0]).toMatchObject({ decidiu: true });
    });
  });

  it('a observação compara o AGENTE FINAL: duas intenções do mesmo agente concordam; o mínimo leva ao de reserva', async () => {
    const r = router({
      fallbackAgentId: 'agent-reserva',
      members: [...members, { agentId: 'agent-vendas', intentName: 'orcamento', intentDescription: 'quer preço', examples: [] }],
    });
    const jev = jevFalso('observando');
    await rodar({ daIa: { intentName: 'vendas', confidence: 0.9 }, jev, r });
    const { rotuloDe } = jev.jev.observar.mock.calls[0]![0] as { rotuloDe: (v: { intentName: string | null; confidence: number }) => string };
    expect(rotuloDe({ intentName: 'orcamento', confidence: 0.9 })).toBe(rotuloDe({ intentName: 'vendas', confidence: 0.7 }));
    expect(rotuloDe({ intentName: 'vendas', confidence: 0.5 })).toBe('agent-reserva');
    expect(rotuloDe({ intentName: null, confidence: 0.99 })).toBe('agent-reserva');
    expect(rotuloDe({ intentName: 'suporte', confidence: 0.9 })).toBe('agent-suporte');
  });

  it('com sticky, a observação usa a régua do sticky: resposta curta sem certeza fica com o agente de antes', async () => {
    const jev = jevFalso('observando');
    await rodar({
      daIa: { intentName: 'vendas', confidence: 0.9 },
      jev,
      entrada: { ...semSticky, signal: 'sim', stickyAgentId: 'agent-suporte', stickyIntent: 'suporte' },
    });
    const { rotuloDe } = jev.jev.observar.mock.calls[0]![0] as { rotuloDe: (v: { intentName: string | null; confidence: number }) => string };
    expect(rotuloDe({ intentName: null, confidence: 0.95 })).toBe('agent-suporte');
  });

  it('a observação vai amarrada à mensagem que o turno classificou', async () => {
    const jev = jevFalso('observando');
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('from conversations')) return { rows: [{ active_ai_agent_id: null, active_intent: null }] };
        if (sql.includes('id<>$3')) return { rows: [] };
        return { rows: [{ id: 'msg-atual', body: 'quero comprar' }] };
      }),
    };
    await resolveConversationTurn(db as never, {} as never, { ...baseInput, inbound: true }, makeDeps({
      loadActiveRouter: vi.fn().mockResolvedValue(router()),
      loadPublishedAgentConfigById: idAwareLoader(),
      classifyIntent: vi.fn().mockResolvedValue({ intentName: 'vendas', confidence: 0.9 }),
      consultarJev: jev.consultarJev,
    }));
    expect(jev.jev.observar.mock.calls[0]![0]).toMatchObject({ messageId: 'msg-atual', conversationId: 'conv-1' });
  });

  it('sem mensagem nova (follow-up), o Jev nem é consultado', async () => {
    const jev = jevFalso('observando');
    await rodar({ daIa: null, jev, entrada: { ...semSticky, signal: null } });
    expect(jev.consultarJev).not.toHaveBeenCalled();
  });
});

describe('destinoDoVeredito — a régua única (regras 2 a 5, sem carregar agente)', () => {
  const r = router({ fallbackAgentId: 'agent-reserva' });
  const sticky = members[0];
  it.each([
    ['sem sticky, casou', undefined, null, { intentName: 'suporte', confidence: 0.9 }, 'classified', 'agent-suporte'],
    ['sem sticky, abaixo do mínimo', undefined, null, { intentName: 'suporte', confidence: 0.5 }, 'no_match', 'agent-reserva'],
    ['sem sticky, nenhuma', undefined, null, { intentName: null, confidence: 0.9 }, 'no_match', 'agent-reserva'],
    ['sem sticky, sem veredito', undefined, null, null, 'classifier_failed', 'agent-reserva'],
    ['sticky, outra intenção com certeza', sticky, 'vendas', { intentName: 'suporte', confidence: 0.9 }, 'reclassified', 'agent-suporte'],
    ['sticky, outra intenção sem certeza', sticky, 'vendas', { intentName: 'suporte', confidence: 0.5 }, 'sticky', 'agent-vendas'],
    ['sticky, a mesma intenção', sticky, 'vendas', { intentName: 'vendas', confidence: 0.9 }, 'sticky', 'agent-vendas'],
    ['sticky, sem veredito', sticky, 'vendas', null, 'sticky', 'agent-vendas'],
    // Um veredito torto não vira exceção no turno: intenção que o roteador não tem é "nenhuma".
    ['sem sticky, intenção desconhecida', undefined, null, { intentName: 'financeiro', confidence: 0.99 }, 'no_match', 'agent-reserva'],
    ['sticky, intenção desconhecida', sticky, 'vendas', { intentName: 'financeiro', confidence: 0.99 }, 'sticky', 'agent-vendas'],
  ] as const)('%s', (_caso, stickyMember, stickyIntent, verdict, outcome, agente) => {
    const d = destinoDoVeredito(r, stickyMember, stickyIntent, verdict);
    expect(d.outcome).toBe(outcome);
    expect(agenteDoDestino(r, d)).toBe(agente);
  });

  it("sem agente de reserva no roteador, a reserva é o publicado da sessão — rótulo 'fallback' para os dois lados", () => {
    expect(agenteDoDestino(router(), destinoDoVeredito(router(), undefined, null, null))).toBe('fallback');
  });
});
