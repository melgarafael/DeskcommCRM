/**
 * #4318 — A PASSAGEM EXPLÍCITA ENTRE AGENTES VALE PELO TURNO SEGUINTE.
 *
 * ─── O defeito medido ────────────────────────────────────────────────────────
 *
 * Com roteador ativo e sticky ligado, `transferir-agente` (ação) e
 * `transfer_to_agent` (ferramenta) gravavam `active_ai_agent_id`/`active_intent`
 * e nada mais. No turno seguinte o classificador rodava de novo e a regra 2 de
 * `destinoDoVeredito` devolvia `reclassified` sempre que a intenção vinha
 * diferente da gravada com confiança >= `min_confidence` — ou seja, a primeira
 * mensagem do cliente que o classificador entendesse como outro assunto
 * desfazia a passagem que uma pessoa (ou o próprio agente) tinha pedido.
 *
 * ─── O que este arquivo mede, em dois (e três) turnos de verdade ─────────────
 *
 *  - turno 1: a passagem explícita, pela AÇÃO de produção
 *    (`transferirAgenteDaConversa`), grava agente, intenção e a marca da
 *    passagem (`active_agent_transfer_at`, no mesmo instante de
 *    `active_agent_set_at`);
 *  - turno 2: mensagem do cliente que o classificador entende como OUTRO
 *    assunto, com confiança alta — quem atende é o agente PASSADO, e não o que
 *    o classificador apontou;
 *  - turno 3, depois de o agente passado atender (o turno reescreve
 *    `active_agent_set_at`, que consome a marca): o classificador volta a
 *    mandar. O roteador não vira inerte.
 *
 * As bordas que a issue nomeia, cada uma com o seu caso: conversa ARQUIVADA
 * (nada no turno lê `status` — a passagem sobrevive), agente de destino
 * DESATIVADO (saiu de `router.members`, então não há passagem a segurar: vale a
 * régua normal) e veredito de confiança BAIXA (já era sticky pela regra 2 — a
 * passagem não é o que segura, e o teste afirma isso pelo log).
 *
 * ─── O harness ───────────────────────────────────────────────────────────────
 *
 * Banco fingido com o estado da conversa e as três consultas que o caminho faz
 * (leitura do sticky, UPDATE da passagem e leitura do turno), com relógio
 * próprio: `now()` é determinístico e a cada escrita avança um segundo. É o que
 * permite afirmar a IGUALDADE dos dois carimbos (passagem pendente) e a
 * divergência deles depois do turno (passagem consumida) sem depender do relógio
 * de parede.
 *
 * O passo que CONSOME a marca é o UPDATE de aderência de `inbound-turn.ts`, que
 * não roda aqui (o harness resolve o turno, não o turno inteiro). Ele entra como
 * `persistirStickyDoTurno` — com o MESMO SQL de produção — e o arquivo confere
 * por leitura da fonte que aquele SQL continua lá: se alguém parar de reescrever
 * `active_agent_set_at` no turno, a passagem nunca seria consumida e o roteador
 * ficaria inerte; a cerca de fonte acusa.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';

import { destinoDoVeredito, passagemExplicitaPendente, resolveConversationTurn } from './resolve-turn-agent';
import { loadPublishedAgentConfigById, type PublishedAgentConfig } from './agent-config';
import { agenteDaCampanhaDaConversa } from './agente-da-campanha';
import { loadActiveRouter, type LoadedRouter } from './router-config';
import { transferirAgenteDaConversa } from './transferir-agente';

vi.mock('./router-config', () => ({ loadActiveRouter: vi.fn() }));
vi.mock('./agente-da-campanha', () => ({ agenteDaCampanhaDaConversa: vi.fn() }));
vi.mock('./agent-config', () => ({
  loadPublishedAgentConfigById: vi.fn(),
  loadPublishedAgentConfig: vi.fn(),
  escolherAgenteDoNumero: vi.fn(),
}));

const ORG = '11111111-1111-4111-8111-111111111111';
const CONVERSA = '33333333-3333-4333-8333-333333333333';
const CANAL = '44444444-4444-4444-8444-444444444444';
const ROTEADOR = '77777777-7777-4777-8777-777777777777';
const USUARIO = '99999999-9999-4999-8999-999999999999';
const AGENTE_VENDAS = 'aaaaaaaa-2222-4000-8000-000000000001';
const AGENTE_AUTOMACAO = 'aaaaaaaa-2222-4000-8000-000000000002';

function publicado(agentId: string, extra: Partial<PublishedAgentConfig> = {}): PublishedAgentConfig {
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
    pausedAt: null,
    ...extra,
  } as PublishedAgentConfig;
}

function roteador(extra: Partial<LoadedRouter> = {}): LoadedRouter {
  return {
    id: ROTEADOR,
    name: 'Roteador do número',
    classifierModel: 'claude-haiku-4-5',
    classifierProvider: null,
    sticky: true,
    minConfidence: 0.6,
    fallbackAgentId: null,
    members: [
      { agentId: AGENTE_VENDAS, intentName: 'vendas', intentDescription: 'quer comprar', examples: [] },
      { agentId: AGENTE_AUTOMACAO, intentName: 'automacao', intentDescription: 'quer automatizar', examples: [] },
    ],
    ...extra,
  };
}

interface Conversa {
  channel_session_id: string;
  status: string;
  active_ai_agent_id: string | null;
  active_intent: string | null;
  active_agent_set_at: string | null;
  active_agent_transfer_at: string | null;
}

/**
 * O banco fingido: o estado da conversa, as mensagens e as decisões de
 * roteamento. `agora()` avança um segundo por escrita — o relógio determinístico
 * que deixa medir "os dois carimbos são o MESMO instante" (passagem pendente).
 */
function bancoFingido(opcoes: { status?: string } = {}) {
  let relogio = Date.UTC(2026, 10, 12, 13, 0, 0);
  const agora = () => {
    relogio += 1_000;
    return new Date(relogio).toISOString();
  };
  const conversa: Conversa = {
    channel_session_id: CANAL,
    status: opcoes.status ?? 'open',
    active_ai_agent_id: null,
    active_intent: null,
    active_agent_set_at: null,
    active_agent_transfer_at: null,
  };
  const decisoes: { outcome: string; intent: string | null; agent: string | null; origem: string | null }[] = [];
  const consultas: string[] = [];

  const pool = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      consultas.push(sql);
      // A passagem explícita: uma CTE que atualiza a conversa e insere a trilha.
      if (/with destino as \(\s*update conversations/i.test(sql)) {
        conversa.active_ai_agent_id = params[2] as string;
        conversa.active_intent = params[3] as string;
        const carimbo = agora();
        conversa.active_agent_set_at = carimbo;
        conversa.active_agent_transfer_at = carimbo;
        decisoes.push({ outcome: 'transferred', intent: params[3] as string, agent: params[2] as string, origem: 'acao' });
        return { rows: [], rowCount: 1 };
      }
      // A leitura que a própria passagem faz antes de escrever.
      if (/select channel_session_id, active_ai_agent_id\s+from conversations/i.test(sql)) {
        return { rows: [{ channel_session_id: conversa.channel_session_id, active_ai_agent_id: conversa.active_ai_agent_id }] };
      }
      // A leitura do turno (sticky + marca da passagem).
      if (sql.includes('from conversations where organization_id=$1 and id=$2')) {
        return {
          rows: [{
            active_ai_agent_id: conversa.active_ai_agent_id,
            active_intent: conversa.active_intent,
            active_agent_set_at: conversa.active_agent_set_at,
            active_agent_transfer_at: conversa.active_agent_transfer_at,
          }],
        };
      }
      // A aderência da conversa ao agente, gravada pelo turno (`inbound-turn.ts`).
      if (/update conversations\s+set active_ai_agent_id = \$3, active_intent = \$4, active_agent_set_at = now\(\)/i.test(sql)) {
        conversa.active_ai_agent_id = params[2] as string;
        conversa.active_intent = params[3] as string;
        conversa.active_agent_set_at = agora();
        return { rows: [] };
      }
      // O contexto curto do classificador.
      if (sql.includes('id<>$3')) return { rows: [] };
      // A última mensagem inbound — o sinal do turno.
      if (sql.includes("direction='inbound'")) {
        return { rows: [{ id: 'msg-1', body: 'quero automatizar meus atendimentos', type: 'text', media_url: null, media_storage_path: null, media_derived_text: null }] };
      }
      throw new Error(`pool dublê sem resposta para: ${sql.slice(0, 90)}`);
    }),
  } as unknown as pg.Pool;

  /**
   * O passo que o TURNO REAL faz logo depois de resolver (`inbound-turn.ts`):
   * grava o agente e a intenção escolhidos e reescreve `active_agent_set_at`.
   * É o que consome a marca da passagem — o mesmo SQL de produção, conferido
   * pela cerca de fonte abaixo.
   */
  const persistirStickyDoTurno = async (agentId: string, intentName: string | null) => {
    await pool.query(
      `update conversations
           set active_ai_agent_id = $3, active_intent = $4, active_agent_set_at = now()
           where organization_id = $1 and id = $2`,
      [ORG, CONVERSA, agentId, intentName],
    );
  };

  return { pool, conversa, decisoes, consultas, persistirStickyDoTurno };
}

function jevDesligado() {
  const jev = {
    estado: Promise.resolve('desligada' as const),
    escolha: Promise.resolve(null),
    modo: Promise.resolve('comparacao' as const),
    observar: vi.fn(),
  };
  return vi.fn(() => jev);
}

/** As deps do turno, com o classificador que o caso controla. */
function depsDoTurno(classifyIntent: ReturnType<typeof vi.fn>, log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }) {
  return {
    log,
    classifyIntent,
    registrarDecisao: vi.fn(),
    carregarFatosDoCrmDoContato: vi.fn().mockResolvedValue({
      fatos: { funis: [], etiquetas: [], funisOmitidos: 0, etiquetasOmitidas: 0 }, motivo: null,
    }),
    consultarJev: jevDesligado(),
    temIaDeSempre: vi.fn().mockResolvedValue(true),
    agenteDaCampanha: vi.fn().mockResolvedValue(null),
  } as never;
}

const entradaDoTurno = {
  tenantId: ORG,
  leadId: '22222222-2222-4222-8222-222222222222',
  jobId: '55555555-5555-4555-8555-555555555555',
  conversationId: CONVERSA,
  channelSessionId: CANAL,
  inbound: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadActiveRouter).mockResolvedValue(roteador());
  vi.mocked(agenteDaCampanhaDaConversa).mockResolvedValue(null);
  vi.mocked(loadPublishedAgentConfigById).mockImplementation(async (_db, _org, id) => publicado(id));
});

describe('#4318 — a passagem explícita sobrevive ao turno seguinte', () => {
  it('turno 1 passa a conversa, turno 2 traz outro assunto com confiança alta: quem atende é o agente PASSADO', async () => {
    const banco = bancoFingido();
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    // ── turno 1: a passagem explícita, pela ação de produção ──
    await transferirAgenteDaConversa(banco.pool, {
      organizationId: ORG,
      conversationId: CONVERSA,
      agenteDestinoId: AGENTE_AUTOMACAO,
      motivo: 'pedido_do_operador',
      solicitadoPor: USUARIO,
    });
    expect(banco.conversa.active_ai_agent_id).toBe(AGENTE_AUTOMACAO);
    expect(banco.conversa.active_intent).toBe('automacao');
    // A marca: os dois carimbos no MESMO instante = passagem pendente.
    expect(banco.conversa.active_agent_transfer_at).toBe(banco.conversa.active_agent_set_at);
    expect(passagemExplicitaPendente(banco.conversa.active_agent_set_at, banco.conversa.active_agent_transfer_at)).toBe(true);

    // ── turno 2: o cliente fala de OUTRO assunto, e o classificador concorda ──
    const classifyIntent = vi.fn().mockResolvedValue({ intentName: 'vendas', confidence: 0.93 });
    const turno2 = await resolveConversationTurn(banco.pool, {} as never, entradaDoTurno, depsDoTurno(classifyIntent, log));

    expect(classifyIntent).toHaveBeenCalled();
    // O defeito da issue: aqui saía `reclassified` com o agente de vendas.
    expect(turno2.outcome).toBe('sticky');
    expect(turno2.config?.agentId).toBe(AGENTE_AUTOMACAO);
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining('passagem explícita segurou o agente'),
      expect.objectContaining({ agentePassadoId: AGENTE_AUTOMACAO, intentDoClassificador: 'vendas' }),
    );
  });

  it('turno 3 (o agente passado já atendeu): o classificador volta a mandar — o roteador não vira inerte', async () => {
    const banco = bancoFingido();
    await transferirAgenteDaConversa(banco.pool, {
      organizationId: ORG, conversationId: CONVERSA, agenteDestinoId: AGENTE_AUTOMACAO,
      motivo: 'pedido_do_operador', solicitadoPor: USUARIO,
    });
    const classifyIntent = vi.fn().mockResolvedValue({ intentName: 'vendas', confidence: 0.93 });

    const turno2 = await resolveConversationTurn(banco.pool, {} as never, entradaDoTurno, depsDoTurno(classifyIntent));
    expect(turno2.config?.agentId).toBe(AGENTE_AUTOMACAO);
    // O turno 2 atende de verdade: a aderência é regravada (o SQL de produção).
    await banco.persistirStickyDoTurno(turno2.config!.agentId, turno2.intentName);
    expect(passagemExplicitaPendente(banco.conversa.active_agent_set_at, banco.conversa.active_agent_transfer_at)).toBe(false);

    // ── turno 3: a marca foi consumida, vale a regra 2 de sempre ──
    const turno3 = await resolveConversationTurn(banco.pool, {} as never, entradaDoTurno, depsDoTurno(classifyIntent));
    expect(turno3.outcome).toBe('reclassified');
    expect(turno3.config?.agentId).toBe(AGENTE_VENDAS);
  });

  it('controle: SEM passagem explícita, o turno seguinte reclassifica como sempre (a régua do classificador continua viva)', async () => {
    const banco = bancoFingido();
    // Sticky comum: o turno anterior escolheu o agente, não uma pessoa.
    banco.conversa.active_ai_agent_id = AGENTE_AUTOMACAO;
    banco.conversa.active_intent = 'automacao';
    banco.conversa.active_agent_set_at = new Date(Date.UTC(2026, 10, 12, 12, 0, 0)).toISOString();
    expect(passagemExplicitaPendente(banco.conversa.active_agent_set_at, banco.conversa.active_agent_transfer_at)).toBe(false);

    const classifyIntent = vi.fn().mockResolvedValue({ intentName: 'vendas', confidence: 0.93 });
    const turno = await resolveConversationTurn(banco.pool, {} as never, entradaDoTurno, depsDoTurno(classifyIntent));
    expect(turno.outcome).toBe('reclassified');
    expect(turno.config?.agentId).toBe(AGENTE_VENDAS);
  });

  it('conversa ARQUIVADA: a passagem sobrevive — o turno não lê `status`, e nada a desfaz', async () => {
    const banco = bancoFingido({ status: 'archived' });
    await transferirAgenteDaConversa(banco.pool, {
      organizationId: ORG, conversationId: CONVERSA, agenteDestinoId: AGENTE_AUTOMACAO,
      motivo: 'pedido_do_operador', solicitadoPor: USUARIO,
    });
    const classifyIntent = vi.fn().mockResolvedValue({ intentName: 'vendas', confidence: 0.93 });

    const turno = await resolveConversationTurn(banco.pool, {} as never, entradaDoTurno, depsDoTurno(classifyIntent));
    expect(banco.conversa.status).toBe('archived');
    expect(turno.outcome).toBe('sticky');
    expect(turno.config?.agentId).toBe(AGENTE_AUTOMACAO);
  });

  it('agente de destino DESATIVADO (saiu do roteador): não há passagem a segurar — vale a régua normal', async () => {
    const banco = bancoFingido();
    await transferirAgenteDaConversa(banco.pool, {
      organizationId: ORG, conversationId: CONVERSA, agenteDestinoId: AGENTE_AUTOMACAO,
      motivo: 'pedido_do_operador', solicitadoPor: USUARIO,
    });
    // `router-config` junta `ai_agents` com `archived_at is null`: agente
    // desativado não é mais membro, e o turno não tem o que segurar.
    vi.mocked(loadActiveRouter).mockResolvedValue(roteador({
      members: [{ agentId: AGENTE_VENDAS, intentName: 'vendas', intentDescription: 'quer comprar', examples: [] }],
    }));
    const classifyIntent = vi.fn().mockResolvedValue({ intentName: 'vendas', confidence: 0.93 });

    const turno = await resolveConversationTurn(banco.pool, {} as never, entradaDoTurno, depsDoTurno(classifyIntent));
    expect(turno.outcome).toBe('classified');
    expect(turno.config?.agentId).toBe(AGENTE_VENDAS);
  });

  it('agente de destino PAUSADO depois da passagem: a passagem não cala a conversa — vale o classificador', async () => {
    const banco = bancoFingido();
    await transferirAgenteDaConversa(banco.pool, {
      organizationId: ORG, conversationId: CONVERSA, agenteDestinoId: AGENTE_AUTOMACAO,
      motivo: 'pedido_do_operador', solicitadoPor: USUARIO,
    });
    vi.mocked(loadPublishedAgentConfigById).mockImplementation(async (_db, _org, id) =>
      publicado(id, id === AGENTE_AUTOMACAO ? { pausedAt: '2026-11-12T12:30:00.000Z' } : {}),
    );
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const classifyIntent = vi.fn().mockResolvedValue({ intentName: 'vendas', confidence: 0.93 });

    const turno = await resolveConversationTurn(banco.pool, {} as never, entradaDoTurno, depsDoTurno(classifyIntent, log));
    expect(turno.outcome).toBe('reclassified');
    expect(turno.config?.agentId).toBe(AGENTE_VENDAS);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('a passagem explícita não segura o agente'),
      expect.objectContaining({ agentePassadoId: AGENTE_AUTOMACAO, motivo: 'pausado' }),
    );
  });

  it('veredito de confiança BAIXA: já era sticky pela regra 2 — não é a passagem que segura', async () => {
    const banco = bancoFingido();
    await transferirAgenteDaConversa(banco.pool, {
      organizationId: ORG, conversationId: CONVERSA, agenteDestinoId: AGENTE_AUTOMACAO,
      motivo: 'pedido_do_operador', solicitadoPor: USUARIO,
    });
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const classifyIntent = vi.fn().mockResolvedValue({ intentName: 'vendas', confidence: 0.4 });

    const turno = await resolveConversationTurn(banco.pool, {} as never, entradaDoTurno, depsDoTurno(classifyIntent, log));
    expect(turno.outcome).toBe('sticky');
    expect(turno.config?.agentId).toBe(AGENTE_AUTOMACAO);
    // O log da passagem NÃO sai: abaixo do mínimo o classificador não casou
    // ninguém, então não houve reclassificação a segurar.
    expect(log.info).not.toHaveBeenCalledWith(
      expect.stringContaining('passagem explícita segurou o agente'),
      expect.anything(),
    );
  });

  it('a régua pura: `destinoDoVeredito` com a passagem pendente mantém o membro; sem ela, reclassifica', () => {
    const r = roteador();
    const membroPassado = r.members.find((m) => m.agentId === AGENTE_AUTOMACAO)!;
    const veredito = { intentName: 'vendas', confidence: 0.93 };

    const semPassagem = destinoDoVeredito(r, membroPassado, 'automacao', veredito);
    expect(semPassagem.outcome).toBe('reclassified');
    expect(semPassagem.membro?.agentId).toBe(AGENTE_VENDAS);

    const comPassagem = destinoDoVeredito(r, membroPassado, 'automacao', veredito, true);
    expect(comPassagem.outcome).toBe('sticky');
    expect(comPassagem.membro?.agentId).toBe(AGENTE_AUTOMACAO);
    expect(comPassagem).toMatchObject({ intentName: 'automacao', confidence: 0.93 });
  });

  it('a marca só vale com os DOIS carimbos no mesmo instante — e nenhum deles nulo', () => {
    const t = '2026-11-12T13:00:01.000Z';
    expect(passagemExplicitaPendente(t, t)).toBe(true);
    expect(passagemExplicitaPendente(t, '2026-11-12T13:00:02.000Z')).toBe(false);
    expect(passagemExplicitaPendente(null, t)).toBe(false);
    expect(passagemExplicitaPendente(t, null)).toBe(false);
    expect(passagemExplicitaPendente(null, null)).toBe(false);
  });

  it('a cerca de fonte: o turno continua reescrevendo `active_agent_set_at` (é o que consome a marca)', () => {
    const fonte = readFileSync(
      path.join(process.cwd(), 'lib/agent-engine/agent/inbound-turn.ts'),
      'utf8',
    );
    expect(fonte).toContain('set active_ai_agent_id = $3, active_intent = $4, active_agent_set_at = now()');
  });
});
