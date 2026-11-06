/**
 * O RASTRO DO PÚBLICO NO TURNO (#3722) — "quem foi considerado e por que
 * ganhou/perdeu", no caminho de resolução do turno.
 *
 * A régua (`publico-do-gatilho.ts`) e a escolha (`agent-config.ts`) provam
 * QUEM atende. O que este arquivo prova é o que o operador tem na mão quando
 * pergunta "por que o agente de vendas não respondeu?": a resolução do turno
 * carrega o rastro da seleção (`rastroDoPublico`) e o registra UMA vez no log
 * do turno, com a fila inteira — cada candidato, sua posição, se declarou
 * público, e a regra que o liberou ou barrou.
 *
 * O log é o artefato: quem recebe a reclamação não abre o banco. Por isso a
 * asserção é sobre os CAMPOS do log, não sobre uma mensagem solta — um
 * `log.info('público')` sem a fila dentro passaria num teste de substring e
 * não serviria para nada.
 *
 * E o silêncio é preservado: número onde NINGUÉM declarou público não ganha
 * linha nova no log do turno (quem não usa o recurso não paga nem uma linha).
 */
import { describe, expect, it, vi } from 'vitest';

import { resolveTurnAgent } from '@/lib/agent-engine/agent/resolve-turn-agent';
import type { EscolhaDoNumero, PublishedAgentConfig } from '@/lib/agent-engine/agent/agent-config';
import { lerPublicoDoGatilho, type PublicoDoAgente } from '@/lib/agent-engine/agent/publico-do-gatilho';
import { buildClassifierPrompt } from '@/lib/agent-engine/agent/intent-classifier';
import type { LoadedRouter, RouterMember } from '@/lib/agent-engine/agent/router-config';

/** Config mínima válida — só o agentId importa aqui. */
function fakeConfig(agentId: string, publicoDoGatilho: PublicoDoAgente | null = null): PublishedAgentConfig {
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
    operatorToolIds: [],
    pipelineIds: [],
    agentCreatedBy: null,
    vozEnabled: false,
    vozQuando: 'espelhar',
    maxSendsPerTurn: null,
    handoffTargetUserId: null,
    publicoDoGatilho,
  };
}

const input = {
  tenantId: 'org-1',
  leadId: 'contato-1',
  jobId: 'job-1',
  channelSessionId: 'sess-1',
  conversationId: 'conv-1',
  signal: 'meu contrato está errado',
  stickyAgentId: null,
  stickyIntent: null,
};

/** A fila que a seleção devolve no caso da issue: o vendedor perde, o suporte ganha. */
const ESCOLHA_COM_RASTRO: EscolhaDoNumero = {
  config: fakeConfig('suporte'),
  motivo: 'publico_liberou',
  rastro: {
    contatoAvaliado: true,
    escolhidoAgentId: 'suporte',
    candidatos: [
      {
        agentId: 'vendas',
        agentName: 'Vendedor',
        posicao: 0,
        pausado: false,
        semPublico: false,
        decisao: { passa: false, regra: 'barrado_por_etiqueta_excluida', valor: 'cliente ativo' },
      },
      {
        agentId: 'suporte',
        agentName: 'Suporte',
        posicao: 1,
        pausado: false,
        semPublico: false,
        decisao: { passa: true, regra: 'passou', valor: null },
      },
    ],
  },
};

function depsCom(escolha: EscolhaDoNumero) {
  const info = vi.fn();
  return {
    deps: {
      log: { info, warn: vi.fn(), error: vi.fn() },
      loadActiveRouter: vi.fn().mockResolvedValue(null),
      escolherAgenteDoNumero: vi.fn().mockResolvedValue(escolha),
    } as never,
    info,
  };
}

const linhaDoRastro = (info: ReturnType<typeof vi.fn>) =>
  info.mock.calls.find((c) => String(c[0]).includes('público do agente'));

describe('rastro do público na resolução do turno (#3722)', () => {
  it('a resolução carrega o rastro da seleção (quem foi considerado)', async () => {
    const { deps } = depsCom(ESCOLHA_COM_RASTRO);
    const out = await resolveTurnAgent({} as never, {} as never, input, deps);

    expect(out.outcome).toBe('no_router');
    expect(out.config?.agentId).toBe('suporte');
    expect(out.rastroDoPublico).toEqual(ESCOLHA_COM_RASTRO.rastro);
  });

  it('o log do turno nomeia o candidato barrado, a regra e o item — com campos, não frase', async () => {
    const { deps, info } = depsCom(ESCOLHA_COM_RASTRO);
    await resolveTurnAgent({} as never, {} as never, input, deps);

    const chamada = linhaDoRastro(info);
    expect(chamada, 'o turno tem de registrar quem foi considerado').toBeDefined();
    const campos = chamada![1] as {
      escolhido: string | null;
      contatoAvaliado: boolean;
      candidatos: Record<string, unknown>[];
    };
    expect(campos.escolhido).toBe('suporte');
    expect(campos.contatoAvaliado).toBe(true);
    expect(campos.candidatos).toEqual([
      {
        agente: 'Vendedor',
        posicao: 0,
        pausado: false,
        sem_publico: false,
        regra: 'barrado_por_etiqueta_excluida',
        valor: 'cliente ativo',
      },
      { agente: 'Suporte', posicao: 1, pausado: false, sem_publico: false, regra: 'passou', valor: null },
    ]);
  });

  it('o rastro registra em log não leva dado do contato — só o item DECLARADO na config', async () => {
    const { deps, info } = depsCom(ESCOLHA_COM_RASTRO);
    await resolveTurnAgent({} as never, {} as never, input, deps);

    const campos = linhaDoRastro(info)![1] as Record<string, unknown>;
    // Nada de lista de etiquetas do contato nem telefone/nome: a disciplina de
    // PII do logger é do call site, e este é o call site.
    expect(Object.keys(campos).sort()).toEqual(
      ['candidatos', 'contactId', 'contatoAvaliado', 'conversationId', 'escolhido', 'tenantId'].sort(),
    );
    expect(JSON.stringify(campos)).not.toContain('5511');
  });

  it('número sem público declarado: nenhum rastro, nenhuma linha nova no log', async () => {
    const semRastro: EscolhaDoNumero = { config: fakeConfig('unico'), motivo: 'primeiro_da_fila' };
    const { deps, info } = depsCom(semRastro);
    const out = await resolveTurnAgent({} as never, {} as never, input, deps);

    expect(out.config?.agentId).toBe('unico');
    expect(out.rastroDoPublico).toBeUndefined();
    expect(linhaDoRastro(info), 'quem não usa o público não ganha log novo por turno').toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// FATIA 2 — o público chega ao ROTEADOR (#3722)
//
// A fatia 1 provou a escolha do agente do NÚMERO. Aqui se prova o buraco que
// sobrou: o roteador oferecia ao classificador (e ao Jev) a intenção do membro
// que o público barra. Estes casos olham a LISTA ENVIADA — não o resultado —,
// porque é ela que decide o que o modelo pode escolher.
// ═══════════════════════════════════════════════════════════════════════════

/** O público do caso da issue: o vendedor não atende quem já é cliente. */
const NAO_ATENDE_CLIENTE = lerPublicoDoGatilho({ filters: { exclude_tags: ['cliente ativo'] } });
/** Exige etiqueta — barra o contato que não a tem. */
const SO_INADIMPLENTE = lerPublicoDoGatilho({ filters: { include_tags: ['inadimplente'] } });

function membroDoRouter(
  agentId: string,
  intentName: string,
  publicoDoGatilho: PublicoDoAgente | null = null,
): RouterMember {
  return { agentId, intentName, intentDescription: `assunto de ${intentName}`, examples: [], publicoDoGatilho };
}

function routerCom(members: RouterMember[], over: Partial<LoadedRouter> = {}): LoadedRouter {
  return {
    id: 'router-1',
    name: 'R',
    classifierModel: 'claude-haiku-4-5',
    classifierProvider: null,
    sticky: true,
    minConfidence: 0.6,
    fallbackAgentId: null,
    members,
    ...over,
  };
}

/**
 * Banco mínimo do turno: `query` responde os fatos do contato e MAIS NADA.
 * `query` é o espião de "quantas vezes o contato foi lido neste turno".
 */
function bancoCom(tags: string[], funis: string[] = []) {
  const query = vi.fn().mockResolvedValue({ rows: [{ tags, funis }] });
  return { db: { query } as never, query };
}

function depsDoTurno(over: {
  router: LoadedRouter | null;
  classifyIntent?: ReturnType<typeof vi.fn>;
  escolhaDoNumero?: ReturnType<typeof vi.fn>;
  configById?: (id: string) => PublishedAgentConfig;
}) {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const jev = {
    estado: Promise.resolve('desligada' as const),
    escolha: Promise.resolve(null),
    modo: Promise.resolve('comparacao' as const),
    observar: vi.fn(),
  };
  const consultarJev = vi.fn(() => jev);
  // A gravação da decisão é o que cria o caso/leva o turno para o agente: ela é
  // o espião de "nenhum caso criado" quando o público barra todo mundo.
  const registrarDecisao = vi.fn().mockResolvedValue(undefined);
  const deps = {
    log,
    loadActiveRouter: vi.fn().mockResolvedValue(over.router),
    // Sem campanha no caminho: a consulta dela também usaria o `query` do banco.
    agenteDaCampanha: vi.fn().mockResolvedValue(null),
    loadPublishedAgentConfigById: vi.fn(async (_db: unknown, _org: unknown, id: string) =>
      (over.configById?.(id)) ?? fakeConfig(id)),
    classifyIntent: over.classifyIntent ?? vi.fn().mockResolvedValue({ intentName: null, confidence: 0 }),
    consultarJev,
    // A gravação da decisão usaria o `query` do banco e sujaria a contagem.
    registrarDecisao,
    ...(over.escolhaDoNumero ? { escolherAgenteDoNumero: over.escolhaDoNumero } : {}),
  } as never;
  return { deps, log, consultarJev, registrarDecisao };
}

const turno = (extra: Record<string, unknown> = {}) => ({ ...input, ...extra });

describe('público do agente no roteador (#3722, fatia 2)', () => {
  it('1. membro barrado pelo público NÃO vai na pergunta do classificador', async () => {
    const members = [
      membroDoRouter('agente-vendas', 'vendas', NAO_ATENDE_CLIENTE),
      membroDoRouter('agente-suporte', 'suporte'),
    ];
    const classifyIntent = vi.fn().mockResolvedValue({ intentName: 'suporte', confidence: 0.9 });
    const { db, query } = bancoCom(['cliente ativo']);
    const { deps, consultarJev } = depsDoTurno({ router: routerCom(members), classifyIntent });

    const out = await resolveTurnAgent(db, {} as never, turno(), deps);

    // A LISTA ENVIADA à IA de sempre é a filtrada — é isto que o modelo pode
    // escolher, e é por isso que o membro barrado não pode ganhar o turno.
    const enviado = classifyIntent.mock.calls[0]![2] as { router: LoadedRouter };
    expect(enviado.router.members.map((m) => m.intentName)).toEqual(['suporte']);
    const prompt = buildClassifierPrompt(enviado.router.members, input.signal);
    expect(prompt).not.toContain('- vendas:');
    expect(prompt).toContain('- suporte:');
    // E a do Jev também: ele é perguntado sobre a mesma lista.
    const perguntaAoJev = consultarJev.mock.calls[0]![1] as { membros: RouterMember[] };
    expect(perguntaAoJev.membros.map((m) => m.intentName)).toEqual(['suporte']);
    // Uma leitura do contato por turno — nem uma a mais.
    expect(query).toHaveBeenCalledTimes(1);

    expect(out.outcome).toBe('classified');
    expect(out.config?.agentId).toBe('agente-suporte');
    // O rastro do turno: quantos barrou e por qual regra.
    expect(out.rastroDoPublico?.roteador).toMatchObject({
      motivo: 'publico_liberou',
      julgados: 1,
      barrados: 1,
      elegiveis: 1,
      porRegra: [{ intentName: 'vendas', regra: 'barrado_por_etiqueta_excluida', valor: 'cliente ativo' }],
      fallbackBarrado: false,
    });
  });

  it('2. todos os membros barrados: nenhum modelo é chamado, nenhum caso, rastro publico_barrou', async () => {
    const members = [
      membroDoRouter('agente-vendas', 'vendas', NAO_ATENDE_CLIENTE),
      membroDoRouter('agente-cobranca', 'cobranca', SO_INADIMPLENTE),
    ];
    const classifyIntent = vi.fn();
    const escolhaDoNumero = vi.fn().mockResolvedValue({ config: null, motivo: 'publico_barrou' });
    const { db, query } = bancoCom(['cliente ativo']);
    const { deps, log, consultarJev, registrarDecisao } = depsDoTurno({
      router: routerCom(members),
      classifyIntent,
      escolhaDoNumero,
    });

    const out = await resolveTurnAgent(db, {} as never, turno(), deps);

    expect(query).toHaveBeenCalledTimes(1);
    // ZERO chamadas de modelo: nem a IA de sempre, nem o Jev.
    expect(classifyIntent).not.toHaveBeenCalled();
    expect(consultarJev).not.toHaveBeenCalled();
    // E nenhum caso criado: sem agente escolhido não há decisão a gravar.
    expect(registrarDecisao).not.toHaveBeenCalled();
    // Conversa sem dono, turno silencioso — sem aviso na Central (nenhum warn).
    expect(out.config).toBeNull();
    expect(out.silencioPeloPublico).toBe(true);
    expect(log.warn).not.toHaveBeenCalled();
    expect(out.rastroDoPublico?.roteador).toMatchObject({ motivo: 'publico_barrou', barrados: 2, elegiveis: 0 });
    expect(out.rastroDoPublico?.roteador?.porRegra.map((b) => b.regra)).toEqual([
      'barrado_por_etiqueta_excluida',
      'barrado_por_etiqueta_exigida',
    ]);
  });

  it('3. fallback barrado pelo público não assume: silêncio registrado, conversa sem dono', async () => {
    const members = [
      membroDoRouter('agente-vendas', 'vendas', NAO_ATENDE_CLIENTE),
      membroDoRouter('agente-suporte', 'suporte'),
    ];
    // A classificação não casa nada → o turno cai no fallback.
    const classifyIntent = vi.fn().mockResolvedValue({ intentName: null, confidence: 0 });
    const { db } = bancoCom(['cliente ativo']);
    const { deps } = depsDoTurno({
      router: routerCom(members, { fallbackAgentId: 'agente-padrao' }),
      classifyIntent,
      // O fallback TAMBÉM declarou o mesmo público.
      configById: (id) => (id === 'agente-padrao' ? fakeConfig(id, NAO_ATENDE_CLIENTE) : fakeConfig(id)),
    });

    const out = await resolveTurnAgent(db, {} as never, turno(), deps);

    expect(classifyIntent).toHaveBeenCalled();
    expect(out.config).toBeNull();
    expect(out.silencioPeloPublico).toBe(true);
    expect(out.rastroDoPublico?.roteador?.fallbackBarrado).toBe(true);
  });

  it('4a. agente grudado que deixou de ser elegível PERDE a vez: a escolha volta ao conjunto elegível', async () => {
    const members = [
      membroDoRouter('agente-vendas', 'vendas', NAO_ATENDE_CLIENTE),
      membroDoRouter('agente-suporte', 'suporte'),
    ];
    // O modelo devolve a intenção do agente GRUDADO (a conversa continua "de
    // vendas"). No conserto ela não está mais na lista oferecida, então não
    // casa com ninguém e o agente de antes não recupera o turno por stickiness.
    const classifyIntent = vi.fn().mockResolvedValue({ intentName: 'vendas', confidence: 0.95 });
    const escolhaDoNumero = vi.fn().mockResolvedValue({ config: null, motivo: 'publico_barrou' });
    const { db } = bancoCom(['cliente ativo']);
    const { deps } = depsDoTurno({ router: routerCom(members), classifyIntent, escolhaDoNumero });

    const out = await resolveTurnAgent(
      db, {} as never,
      turno({ stickyAgentId: 'agente-vendas', stickyIntent: 'vendas' }),
      deps,
    );

    const enviado = classifyIntent.mock.calls[0]![2] as { router: LoadedRouter };
    expect(enviado.router.members.map((m) => m.intentName)).toEqual(['suporte']);
    expect(out.outcome).not.toBe('sticky');
    expect(out.config).toBeNull();
    expect(out.silencioPeloPublico).toBe(true);
  });

  it('4b. agente grudado barrado e outro elegível: o turno passa para quem atende', async () => {
    const members = [
      membroDoRouter('agente-vendas', 'vendas', NAO_ATENDE_CLIENTE),
      membroDoRouter('agente-suporte', 'suporte'),
    ];
    const classifyIntent = vi.fn().mockResolvedValue({ intentName: 'suporte', confidence: 0.9 });
    const { db } = bancoCom(['cliente ativo']);
    const { deps } = depsDoTurno({ router: routerCom(members), classifyIntent });

    const out = await resolveTurnAgent(
      db, {} as never,
      turno({ stickyAgentId: 'agente-vendas', stickyIntent: 'vendas' }),
      deps,
    );

    expect(out.outcome).toBe('classified');
    expect(out.config?.agentId).toBe('agente-suporte');
  });

  it('4c. agente grudado barrado e nenhum elegível: silêncio, não insiste no agente de antes', async () => {
    const members = [
      membroDoRouter('agente-vendas', 'vendas', NAO_ATENDE_CLIENTE),
      membroDoRouter('agente-cobranca', 'cobranca', NAO_ATENDE_CLIENTE),
    ];
    const escolhaDoNumero = vi.fn().mockResolvedValue({ config: null, motivo: 'publico_barrou' });
    const { db } = bancoCom(['cliente ativo']);
    const { deps } = depsDoTurno({ router: routerCom(members), escolhaDoNumero });

    const out = await resolveTurnAgent(
      db, {} as never,
      turno({ stickyAgentId: 'agente-vendas', stickyIntent: 'vendas' }),
      deps,
    );

    expect(out.config).toBeNull();
    expect(out.outcome).not.toBe('sticky');
    expect(out.silencioPeloPublico).toBe(true);
  });

  it('6. org sem público configurado: comportamento de hoje e ZERO leitura dos fatos do contato', async () => {
    const members = [membroDoRouter('agente-vendas', 'vendas'), membroDoRouter('agente-suporte', 'suporte')];
    const classifyIntent = vi.fn().mockResolvedValue({ intentName: 'vendas', confidence: 0.9 });
    const { db, query } = bancoCom(['cliente ativo']);
    const { deps } = depsDoTurno({ router: routerCom(members), classifyIntent });

    const out = await resolveTurnAgent(db, {} as never, turno(), deps);

    expect(query, 'quem não configurou público não paga consulta').not.toHaveBeenCalled();
    expect(out.outcome).toBe('classified');
    expect(out.config?.agentId).toBe('agente-vendas');
    expect(out.rastroDoPublico).toBeUndefined();
    // Byte a byte: a MESMA lista (nem clone, nem filtro) vai para o classificador.
    const enviado = classifyIntent.mock.calls[0]![2] as { router: LoadedRouter };
    expect(enviado.router.members).toBe(members);
  });

  it('erro ao LER os fatos do contato não decide no escuro: o job volta para a fila', async () => {
    const members = [membroDoRouter('agente-vendas', 'vendas', NAO_ATENDE_CLIENTE)];
    const classifyIntent = vi.fn();
    const db = { query: vi.fn().mockRejectedValue(new Error('banco fora')) } as never;
    const { deps } = depsDoTurno({ router: routerCom(members), classifyIntent });

    await expect(resolveTurnAgent(db, {} as never, turno(), deps)).rejects.toThrow('banco fora');
    expect(classifyIntent).not.toHaveBeenCalled();
  });
});
