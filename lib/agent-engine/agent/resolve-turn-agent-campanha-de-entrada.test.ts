import { describe, expect, it, vi } from 'vitest';

import { resolveTurnAgent } from './resolve-turn-agent';
import type { PublishedAgentConfig } from './agent-config';
import type { LoadedRouter } from './router-config';

/**
 * O DEGRAU 0b — A CAMPANHA DE ENTRADA, A FRASE DO ANÚNCIO (#4024).
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * A frase do anúncio ("quero saber mais sobre implantes") casa uma campanha em
 * `organizations.settings.campanhas_whatsapp` desde a 0203, e essa campanha
 * declara `agent_id`. Até esta entrega o campo era IGNORADO: o contato ficava
 * elegível e quem respondia era o agente do NÚMERO. Quem atende vários nichos no
 * mesmo WhatsApp mandava a pergunta do implante para o agente do outro nicho.
 *
 * ─── O que este arquivo mede, e o que ele NÃO deixa passar ───────────────────
 *
 * O primeiro turno sai pelo agente da campanha — e só ele. Os lados opostos são
 * a maior parte dos casos aqui, porque cada um deles é uma forma de a mudança
 * virar sequestro de conversa ou de quebrar o turno: sem campanha, campanha sem
 * agente válido (arquivado/sem versão publicada), segunda mensagem, e agente de
 * OUTRA organização.
 */

/** Config mínima válida — `agentId`/`versionId` são a identidade que importa. */
function fakeConfig(agentId: string, versionId = `v-${agentId}`): PublishedAgentConfig {
  return {
    agentId,
    versionId,
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

function router(overrides: Partial<LoadedRouter> = {}): LoadedRouter {
  return {
    id: 'router-1',
    name: 'R',
    classifierModel: 'claude-haiku-4-5',
    classifierProvider: null,
    sticky: true,
    minConfidence: 0.6,
    fallbackAgentId: null,
    members: [
      { agentId: 'agent-vendas', intentName: 'vendas', intentDescription: 'quer comprar', examples: [] },
      { agentId: 'agent-suporte', intentName: 'suporte', intentDescription: 'problema técnico', examples: [] },
    ],
    ...overrides,
  };
}

const baseInput = {
  tenantId: 'org-1',
  leadId: 'lead-1',
  jobId: 'job-1',
  channelSessionId: 'sess-1',
  conversationId: 'conv-1',
  stickyAgentId: null,
  stickyIntent: null,
};

/**
 * Deps com os dois degraus de campanha INJETADOS. O de saída devolve `null` por
 * padrão (a conversa não nasceu de campanha); o de entrada também, salvo o caso
 * que diz o contrário.
 */
function deps(opcoes: {
  daSaida?: string | null;
  daEntrada?: string | null;
  porId?: (id: string) => PublishedAgentConfig | null;
  router?: LoadedRouter | null;
  doNumero?: PublishedAgentConfig | null;
}) {
  const loadPublishedAgentConfigById = vi.fn(async (_db, _org, id: string) =>
    (opcoes.porId ?? ((i: string) => fakeConfig(i)))(id),
  );
  const loadPublishedAgentConfig = vi.fn(async () => opcoes.doNumero ?? fakeConfig('agent-do-numero'));
  const agenteDaCampanha = vi.fn(async () => opcoes.daSaida ?? null);
  const agenteDaCampanhaDeEntrada = vi.fn(async () => opcoes.daEntrada ?? null);
  const classifyIntent = vi.fn(async () => ({ intentName: 'vendas', confidence: 0.9 }));
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    loadPublishedAgentConfigById,
    loadPublishedAgentConfig,
    agenteDaCampanha,
    agenteDaCampanhaDeEntrada,
    classifyIntent,
    log,
    deps: {
      log,
      loadActiveRouter: vi.fn(async () => ('router' in opcoes ? opcoes.router : null)),
      loadPublishedAgentConfigById,
      loadPublishedAgentConfig,
      agenteDaCampanha,
      agenteDaCampanhaDeEntrada,
      classifyIntent,
      consultarJev: vi.fn(() => ({
        estado: Promise.resolve('desligada'),
        escolha: Promise.resolve(null),
        observar: vi.fn(),
      })),
      temIaDeSempre: vi.fn(async () => true),
    } as never,
  };
}

describe('degral 0b: o primeiro turno do contato que veio pela frase do anúncio', () => {
  it('GREEN: quem responde é o agente DA CAMPANHA, com o `agent_id` e o `published_version_id` lidos na decisão', async () => {
    const d = deps({
      daEntrada: 'agente-implantes',
      porId: (id) => (id === 'agente-implantes' ? fakeConfig('agente-implantes', 'versao-publicada-7') : null),
    });

    const out = await resolveTurnAgent({} as never, {} as never, { ...baseInput, signal: 'Quero saber mais sobre implantes' }, d.deps);

    expect(out.outcome).toBe('campanha');
    expect(out.config?.agentId).toBe('agente-implantes');
    // A versão vem do agente publicado (`ai_agents.published_version_id`), não
    // de uma cópia na config da campanha: republicar o agente muda a resposta
    // sem tocar no anúncio.
    expect(out.config?.versionId).toBe('versao-publicada-7');
    expect(d.loadPublishedAgentConfigById).toHaveBeenCalledWith(expect.anything(), 'org-1', 'agente-implantes');
    // O agente do número não é consultado: o degrau está ACIMA dele.
    expect(d.loadPublishedAgentConfig).not.toHaveBeenCalled();
    // Sem roteador, sem classificação: a campanha decide sozinha.
    expect(d.classifyIntent).not.toHaveBeenCalled();
    expect(d.log.info).toHaveBeenCalledWith(
      expect.stringContaining('campanha de entrada'),
      expect.objectContaining({ agentId: 'agente-implantes', agentVersionId: 'versao-publicada-7' }),
    );
  });

  it('o degrau vence o ROTEADOR do número: o classificador nem roda', async () => {
    const d = deps({
      daEntrada: 'agente-implantes',
      router: router(),
      porId: (id) => fakeConfig(id),
    });

    const out = await resolveTurnAgent({} as never, {} as never, { ...baseInput, signal: 'Quero saber mais sobre implantes' }, d.deps);

    expect(out.outcome).toBe('campanha');
    expect(out.config?.agentId).toBe('agente-implantes');
    expect(out.routerId).toBeNull();
    expect(d.classifyIntent).not.toHaveBeenCalled();
  });

  it('(a) contato que NÃO veio de campanha continua como hoje: agente do número', async () => {
    const d = deps({ daEntrada: null, router: null, doNumero: fakeConfig('agent-do-numero') });

    const out = await resolveTurnAgent({} as never, {} as never, { ...baseInput, signal: 'oi, tudo bem?' }, d.deps);

    expect(out.outcome).toBe('no_router');
    expect(out.config?.agentId).toBe('agent-do-numero');
  });

  it('(b1) campanha com agente ARQUIVADO/sem versão publicada cai no agente do número, com aviso e sem erro', async () => {
    // `loadPublishedAgentConfigById` é a régua real: filtra `archived_at is
    // null`, exige `v.status = 'published'` e a organização. Aqui o dublê
    // reproduz o `null` que ela devolve nesses três casos.
    const d = deps({
      daEntrada: 'agente-arquivado',
      router: null,
      porId: () => null,
      doNumero: fakeConfig('agent-do-numero'),
    });

    const out = await resolveTurnAgent({} as never, {} as never, { ...baseInput, signal: 'Quero saber mais sobre implantes' }, d.deps);

    expect(out.outcome).toBe('no_router');
    expect(out.config?.agentId).toBe('agent-do-numero');
    expect(d.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('campanha de entrada sem versão publicada'),
      expect.objectContaining({ conversationId: 'conv-1' }),
    );
  });

  it('(b2) campanha SEM `agent_id` não grava nada e o turno segue como hoje', async () => {
    // O lado da ingestão: `avaliarCampanha` só chama a gravação quando
    // `casada.agent_id !== undefined`. Do lado do turno, o degrau não devolve
    // id nenhum e nada muda — provado pelo dublê devolvendo `null`.
    const d = deps({ daEntrada: null, router: null, doNumero: fakeConfig('agent-do-numero') });

    const out = await resolveTurnAgent({} as never, {} as never, { ...baseInput, signal: 'Quero saber mais sobre implantes' }, d.deps);

    expect(out.config?.agentId).toBe('agent-do-numero');
    expect(d.loadPublishedAgentConfigById).not.toHaveBeenCalled();
  });

  it('(c) a SEGUNDA mensagem não volta para o agente da campanha', async () => {
    // O que o banco devolve depois do carimbo de uso único: nenhuma linha, e
    // portanto `null` no degrau. A conversa volta a ser do número.
    const primeira = deps({ daEntrada: 'agente-implantes', router: null, porId: (id) => fakeConfig(id) });
    const out1 = await resolveTurnAgent({} as never, {} as never, { ...baseInput, signal: 'Quero saber mais sobre implantes' }, primeira.deps);
    expect(out1.config?.agentId).toBe('agente-implantes');

    const segunda = deps({ daEntrada: null, router: null, doNumero: fakeConfig('agent-do-numero') });
    const out2 = await resolveTurnAgent({} as never, {} as never, { ...baseInput, signal: 'e o valor?' }, segunda.deps);
    expect(out2.outcome).toBe('no_router');
    expect(out2.config?.agentId).toBe('agent-do-numero');
  });

  it('(f) agente da campanha de OUTRA organização é RECUSADO e cai no agente do número', async () => {
    // A config da campanha vive no jsonb da organização e aceita qualquer uuid —
    // um id colado da outra empresa não pode virar atendimento. A FK composta da
    // 9332 recusa a gravação; na leitura, `loadPublishedAgentConfigById` filtra
    // por `organization_id` e devolve `null`, que é o que este dublê reproduz.
    const d = deps({
      daEntrada: 'agente-da-outra-org',
      router: null,
      porId: () => null,
      doNumero: fakeConfig('agent-do-numero'),
    });

    const out = await resolveTurnAgent({} as never, {} as never, { ...baseInput, signal: 'Quero saber mais sobre implantes' }, d.deps);

    expect(out.config?.agentId).toBe('agent-do-numero');
    expect(out.config?.agentId).not.toBe('agente-da-outra-org');
    expect(d.loadPublishedAgentConfigById).toHaveBeenCalledWith(expect.anything(), 'org-1', 'agente-da-outra-org');
  });

  it('a campanha de SAÍDA continua tendo a frente (conversa que nasceu da campanha)', async () => {
    const d = deps({
      daSaida: 'agente-prospeccao',
      daEntrada: 'agente-implantes',
      router: null,
      porId: (id) => fakeConfig(id),
    });

    const out = await resolveTurnAgent({} as never, {} as never, { ...baseInput, signal: 'oi' }, d.deps);

    expect(out.config?.agentId).toBe('agente-prospeccao');
    // E o degrau de entrada nem é perguntado: uma campanha decide, e ela basta.
    expect(d.agenteDaCampanhaDeEntrada).not.toHaveBeenCalled();
  });

  it('erro no degrau da campanha de entrada não derruba o turno', async () => {
    // O degrau real já engole o erro (`comTeto`); o dublê devolve uma promessa
    // REJEITADA para provar que nem o pior caso derruba o turno.
    const d = deps({ router: null, doNumero: fakeConfig('agent-do-numero') });
    const comFalha = {
      ...(d.deps as unknown as Record<string, unknown>),
      agenteDaCampanhaDeEntrada: vi.fn(async () => {
        throw new Error('db timeout');
      }),
    };

    const out = await resolveTurnAgent({} as never, {} as never, { ...baseInput, signal: 'oi' }, comFalha as never);

    expect(out.config?.agentId).toBe('agent-do-numero');
  });
});
