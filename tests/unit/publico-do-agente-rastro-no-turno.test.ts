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
import type { IntentVerdict } from '@/lib/agent-engine/agent/intent-classifier';
import type { FatosDoContato, PublicoDoAgente } from '@/lib/agent-engine/agent/publico-do-gatilho';
import type { LoadedRouter, RouterMember } from '@/lib/agent-engine/agent/router-config';

/** Config mínima válida — só o agentId importa aqui. */
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

/* ═══════════════════════════════════════════════════════════════════════════
 * FATIA 2 (#3722) — o público do agente chega ao ROTEADOR.
 *
 * A escolha do agente do número já respeita o público desde a fatia 1. O que
 * estes casos medem é o ROTEADOR: o membro que não atende aquele contato não
 * pode nem ser OFERECIDO ao classificador (Jev e IA de sempre), o fallback
 * barrado não assume, e o agente grudado perde a vez quando deixa de ser
 * elegível.
 *
 * A régua é a MESMA (`publico-do-gatilho.ts`): aqui não há segunda cópia do
 * predicado, só a aplicação dele antes de montar a pergunta.
 * ═══════════════════════════════════════════════════════════════════════════ */

/** Público com as seis listas vazias — cada caso preenche só o que mede. */
function publicoCom(over: Partial<PublicoDoAgente> = {}): PublicoDoAgente {
  return {
    incluirEtiquetas: [],
    excluirEtiquetas: [],
    incluirFunis: [],
    excluirFunis: [],
    incluirOrigens: [],
    excluirOrigens: [],
    ...over,
  };
}

/**
 * Um membro do roteador. O `publico` é o que a versão publicada do agente
 * declarou no `trigger_config`; `null` = atende todo mundo.
 *
 * O `as RouterMember` é de propósito: no dia em que este teste nasceu (prova
 * RED) o campo ainda não existia no tipo — o teste tinha de compilar e falhar
 * por COMPORTAMENTO, não por tipo.
 */
function membro(agentId: string, intentName: string, pub: PublicoDoAgente | null = null): RouterMember {
  return { agentId, intentName, intentDescription: intentName, examples: [], publico: pub } as RouterMember;
}

function routerCom(members: RouterMember[], over: Partial<LoadedRouter> = {}): LoadedRouter {
  return {
    id: 'router-1',
    name: 'R',
    classifierModel: null,
    classifierProvider: null,
    sticky: false,
    minConfidence: 0.6,
    fallbackAgentId: null,
    members,
    ...over,
  };
}

/** Config publicada do agente, com o público que a versão declara. */
function configCom(agentId: string, pub: PublicoDoAgente | null = null): PublishedAgentConfig {
  return { ...fakeConfig(agentId), publico: pub } as PublishedAgentConfig;
}

const SEM_LEAD_ABERTO: FatosDoContato = { etiquetas: [], funisAbertos: [], origem: 'whatsapp' };

/**
 * O cenário do turno com roteador: o que o classificador responde, os fatos do
 * contato e as versões publicadas de cada agente. Tudo o que tocaria banco é
 * dublê — o turno real com Postgres tem os invariants.
 */
function cenario(op: {
  router: LoadedRouter;
  verdict?: IntentVerdict | null;
  fatos?: FatosDoContato | Error;
  configs?: Record<string, PublishedAgentConfig | null>;
  /** O agente publicado da SESSÃO (regra 5, quando o router não tem fallback). */
  sessao?: PublishedAgentConfig | null;
}) {
  const classifyIntent = vi.fn().mockResolvedValue(op.verdict ?? null);
  const carregarFatosDoPublico = vi.fn(async () => {
    if (op.fatos instanceof Error) throw op.fatos;
    return op.fatos ?? SEM_LEAD_ABERTO;
  });
  const loadPublishedAgentConfigById = vi.fn(
    async (_db: unknown, _org: string, id: string) => op.configs?.[id] ?? null,
  );
  const loadPublishedAgentConfig = vi.fn().mockResolvedValue(op.sessao ?? null);
  const info = vi.fn();
  const jev = {
    estado: Promise.resolve('desligada' as const),
    escolha: Promise.resolve(null),
    modo: Promise.resolve('comparacao' as const),
    observar: vi.fn(),
  };
  const consultarJev = vi.fn(
    (_db: unknown, _entrada: { membros: RouterMember[] }, _deps?: unknown) => jev,
  );
  const deps = {
    log: { info, warn: vi.fn(), error: vi.fn() },
    loadActiveRouter: vi.fn().mockResolvedValue(op.router),
    classifyIntent,
    carregarFatosDoPublico,
    carregarFatosDoCrmDoContato: vi.fn().mockResolvedValue({
      fatos: { funis: [], etiquetas: [], funisOmitidos: 0, etiquetasOmitidas: 0 },
      motivo: null,
    }),
    loadPublishedAgentConfigById,
    loadPublishedAgentConfig,
    consultarJev,
    agenteDaCampanha: vi.fn().mockResolvedValue(null),
    registrarDecisao: vi.fn().mockResolvedValue(undefined),
    temIaDeSempre: vi.fn().mockResolvedValue(true),
  } as never;
  return { deps, classifyIntent, carregarFatosDoPublico, info, consultarJev, loadPublishedAgentConfigById };
}

/** A lista de membros que o CLASSIFICADOR recebeu no turno. */
function membrosOferecidosAoClassificador(classifyIntent: ReturnType<typeof vi.fn>): string[] {
  const entrada = classifyIntent.mock.calls[0]![2] as { router: LoadedRouter };
  return entrada.router.members.map((m) => m.agentId);
}

const COM_CLIENTE_ATIVO: FatosDoContato = { etiquetas: ['cliente ativo'], funisAbertos: [], origem: 'whatsapp' };

describe('público do agente no ROTEADOR (#3722, fatia 2)', () => {
  it('1. membro barrado pelo público NÃO é oferecido ao classificador (pergunta montada sem ele)', async () => {
    const router = routerCom([
      membro('vendas', 'vendas', publicoCom({ excluirEtiquetas: ['cliente ativo'] })),
      membro('suporte', 'suporte'),
    ]);
    const { deps, classifyIntent, consultarJev } = cenario({
      router,
      fatos: COM_CLIENTE_ATIVO,
      verdict: { intentName: 'suporte', confidence: 0.9 },
      configs: { suporte: configCom('suporte') },
    });

    const out = await resolveTurnAgent({} as never, {} as never, input, deps);

    expect(membrosOferecidosAoClassificador(classifyIntent)).toEqual(['suporte']);
    // O Jev recebe a MESMA lista: ele escolhe a intenção, e não pode escolher
    // quem o público barrou.
    const entradaDoJev = consultarJev.mock.calls[0]![1] as { membros: RouterMember[] };
    expect(entradaDoJev.membros.map((m) => m.agentId)).toEqual(['suporte']);
    expect(out.config?.agentId).toBe('suporte');
    expect(out.outcome).toBe('classified');
  });

  it('2. todos os membros barrados: nenhum modelo é chamado, nenhum agente assume, rastro diz `publico_barrou`', async () => {
    const bloqueio = publicoCom({ excluirEtiquetas: ['cliente ativo'] });
    const router = routerCom(
      [membro('vendas', 'vendas', bloqueio), membro('suporte', 'suporte', bloqueio)],
      { fallbackAgentId: 'fallback' },
    );
    const { deps, classifyIntent, consultarJev, info, loadPublishedAgentConfigById } = cenario({
      router,
      fatos: COM_CLIENTE_ATIVO,
      verdict: { intentName: 'vendas', confidence: 0.9 },
      // O fallback também é do público de cliente: ele NÃO pode assumir.
      configs: { fallback: configCom('fallback', bloqueio) },
    });

    const out = await resolveTurnAgent({} as never, {} as never, input, deps);

    expect(classifyIntent, 'sem membro elegível não há o que perguntar').not.toHaveBeenCalled();
    expect(consultarJev, 'nem o Jev é perguntado').not.toHaveBeenCalled();
    expect(loadPublishedAgentConfigById, 'o fallback foi avaliado e barrado').toHaveBeenCalledWith(
      expect.anything(), 'org-1', 'fallback',
    );
    expect(out.config).toBeNull();
    expect(out.silencioPeloPublico).toBe(true);
    expect(out.rastroDoPublico).toMatchObject({
      origem: 'roteador',
      motivo: 'publico_barrou',
      contatoAvaliado: true,
      // Dois MEMBROS + o fallback: todos avaliados e barrados.
      barrados: 3,
      escolhidoAgentId: null,
    });
    expect(out.rastroDoPublico?.candidatos.map((c) => [c.agentId, c.decisao?.regra])).toEqual([
      ['vendas', 'barrado_por_etiqueta_excluida'],
      ['suporte', 'barrado_por_etiqueta_excluida'],
      ['fallback', 'barrado_por_etiqueta_excluida'],
    ]);
    const linha = info.mock.calls.find((c) => String(c[0]).includes('membros do roteador considerados'));
    expect(linha?.[1]).toMatchObject({ origem: 'roteador', barrados: 3, motivo: 'publico_barrou' });
  });

  it('3. fallback barrado pelo público não assume: a conversa fica sem dono e o silêncio é registrado', async () => {
    const router = routerCom(
      [membro('vendas', 'vendas', publicoCom({ incluirEtiquetas: ['cliente ativo'] }))],
      { fallbackAgentId: 'fallback' },
    );
    const { deps, classifyIntent } = cenario({
      router,
      fatos: COM_CLIENTE_ATIVO,
      // Nenhuma das intenções se aplica: o caminho é o fallback.
      verdict: { intentName: null, confidence: 0.2 },
      configs: { fallback: configCom('fallback', publicoCom({ excluirEtiquetas: ['cliente ativo'] })) },
    });

    const out = await resolveTurnAgent({} as never, {} as never, input, deps);

    expect(classifyIntent, 'havia membro elegível: o classificador rodou').toHaveBeenCalledTimes(1);
    expect(out.config, 'o fallback barrado não vira dono da conversa').toBeNull();
    expect(out.outcome).toBe('no_match');
    expect(out.silencioPeloPublico).toBe(true);
    expect(out.rastroDoPublico?.candidatos.at(-1)).toMatchObject({
      agentId: 'fallback',
      decisao: { passa: false, regra: 'barrado_por_etiqueta_excluida' },
    });
    expect(out.rastroDoPublico?.barrados).toBe(1);
  });

  it('4. agente grudado que deixou de ser elegível perde a vez, e o turno cai em quem o público aceita', async () => {
    const router = routerCom(
      [
        membro('vendas', 'vendas', publicoCom({ excluirEtiquetas: ['cliente ativo'] })),
        membro('suporte', 'suporte', publicoCom({ incluirEtiquetas: ['cliente ativo'] })),
      ],
      { sticky: true },
    );
    const { deps, classifyIntent } = cenario({
      router,
      fatos: COM_CLIENTE_ATIVO,
      verdict: { intentName: 'suporte', confidence: 0.9 },
      configs: { suporte: configCom('suporte', publicoCom({ incluirEtiquetas: ['cliente ativo'] })) },
    });

    const out = await resolveTurnAgent(
      {} as never,
      {} as never,
      { ...input, stickyAgentId: 'vendas', stickyIntent: 'vendas' },
      deps,
    );

    // O grudado (vendas) não está mais na lista oferecida: a conversa é
    // reclassificada para o suporte em vez de ficar com o vendedor.
    expect(membrosOferecidosAoClassificador(classifyIntent)).toEqual(['suporte']);
    expect(out.config?.agentId).toBe('suporte');
    // Sem o grudado na lista, a escolha volta ao conjunto elegível: é a regra 3
    // (classificação) de novo, não uma reclassificação de uma sticky inválida.
    expect(out.outcome).toBe('classified');
  });

  it('4b. agente grudado barrado e classificador falhando: NÃO fica com o grudado — o fallback elegível assume', async () => {
    const router = routerCom(
      [
        membro('vendas', 'vendas', publicoCom({ excluirEtiquetas: ['cliente ativo'] })),
        membro('suporte', 'suporte'),
      ],
      { sticky: true, fallbackAgentId: 'suporte-fb' },
    );
    const { deps } = cenario({
      router,
      fatos: COM_CLIENTE_ATIVO,
      // `null` = o classificador falhou. Na regra 4 de antes, isso MANTÉM o
      // agente grudado; com o público, o grudado barrado não tem vez.
      verdict: null,
      configs: { 'suporte-fb': configCom('suporte-fb') },
    });

    const out = await resolveTurnAgent(
      {} as never,
      {} as never,
      { ...input, stickyAgentId: 'vendas', stickyIntent: 'vendas' },
      deps,
    );

    expect(out.config?.agentId).toBe('suporte-fb');
    expect(out.outcome).toBe('classifier_failed');
  });

  it('5a. contato sem lead aberto e membro com `include_pipeline_ids` NÃO passa (só estes funis exige card aberto)', async () => {
    const router = routerCom([
      membro('funil-vendas', 'vendas', publicoCom({ incluirFunis: ['funil-vendas'] })),
      membro('sem-funil', 'suporte'),
    ]);
    const { deps, classifyIntent } = cenario({
      router,
      fatos: SEM_LEAD_ABERTO,
      verdict: { intentName: 'suporte', confidence: 0.9 },
      configs: { 'sem-funil': configCom('sem-funil') },
    });

    const out = await resolveTurnAgent({} as never, {} as never, input, deps);

    expect(membrosOferecidosAoClassificador(classifyIntent)).toEqual(['sem-funil']);
    expect(out.config?.agentId).toBe('sem-funil');
  });

  it('5b. contato sem lead aberto e membro com `exclude_pipeline_ids` PASSA (a exclusão não cala quem chega)', async () => {
    const router = routerCom([
      membro('nao-suporte', 'vendas', publicoCom({ excluirFunis: ['funil-suporte'] })),
    ]);
    const { deps, classifyIntent } = cenario({
      router,
      fatos: SEM_LEAD_ABERTO,
      verdict: { intentName: 'vendas', confidence: 0.9 },
      configs: { 'nao-suporte': configCom('nao-suporte') },
    });

    const out = await resolveTurnAgent({} as never, {} as never, input, deps);

    expect(membrosOferecidosAoClassificador(classifyIntent)).toEqual(['nao-suporte']);
    expect(out.config?.agentId).toBe('nao-suporte');
  });

  it('6. org sem nenhum público configurado: comportamento de hoje e ZERO leitura dos fatos do contato', async () => {
    const router = routerCom([membro('vendas', 'vendas'), membro('suporte', 'suporte')]);
    const { deps, classifyIntent, carregarFatosDoPublico } = cenario({
      router,
      verdict: { intentName: 'vendas', confidence: 0.9 },
      configs: { vendas: configCom('vendas') },
    });

    const out = await resolveTurnAgent({} as never, {} as never, input, deps);

    expect(carregarFatosDoPublico, 'quem não configurou público não paga consulta').not.toHaveBeenCalled();
    expect(membrosOferecidosAoClassificador(classifyIntent)).toEqual(['vendas', 'suporte']);
    expect(out.config?.agentId).toBe('vendas');
    expect(out.outcome).toBe('classified');
    expect(out.rastroDoPublico, 'sem público não há rastro').toBeUndefined();
  });

  it('erro ao LER os fatos do contato não decide no escuro: a resolução rejeita (a fila re-tenta)', async () => {
    const router = routerCom([
      membro('vendas', 'vendas', publicoCom({ excluirEtiquetas: ['cliente ativo'] })),
    ]);
    const { deps, classifyIntent } = cenario({
      router,
      fatos: new Error('banco fora'),
      verdict: { intentName: 'vendas', confidence: 0.9 },
      configs: { vendas: configCom('vendas') },
    });

    await expect(resolveTurnAgent({} as never, {} as never, input, deps)).rejects.toMatchObject({
      name: 'ErroDeLeituraDoPublico',
    });
    expect(classifyIntent, 'sem fatos não se escolhe agente no escuro').not.toHaveBeenCalled();
  });
});
