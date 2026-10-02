/**
 * Resolvedor do turno do Intent Router (Fase 3 — Task 4): decide QUAL agente
 * atende o turno — sticky → classificação → fallback → genérico. Task 5
 * (inbound-turn) consome `TurnAgentResolution` no lugar da chamada direta a
 * `loadPublishedAgentConfig` por channel_session.
 *
 * Regra de decisão (spec 2026-07-23, decisões do Rafael 2026-07-26):
 *   1. sem router ativo pra sessão ⇒ fluxo atual intacto (config por sessão).
 *   2. sticky ativo (router.sticky + stickyAgentId ainda membro do router):
 *      classifica MESMO ASSIM (barato, é o que detecta troca de assunto) —
 *      só troca se a intenção vier DIFERENTE da sticky E confiança >= min;
 *      senão mantém o agente sticky.
 *   3. sem sticky: classifica; intenção não-nula + confiança >= min ⇒ agente
 *      do membro.
 *   4. classificador falhou (null) COM sticky elegível ⇒ mantém o sticky
 *      (outcome 'sticky') — um `null` do classificador é informação MAIS
 *      pobre que "sem sinal" (regra 6), nunca deve derrubar a stickiness.
 *      Sem sticky ⇒ fallback se houver, outcome sempre 'classifier_failed'
 *      (categoria própria, distinta de "classificou e não bateu" — ver
 *      task-4-report.md, review T4 finding 1).
 *   5. sem match / confiança baixa ⇒ fallback se houver (outcome 'fallback'),
 *      senão o agente PUBLICADO DA SESSÃO — o mesmo que responderia se o router
 *      não existisse. Só quando nem esse existe é que sai config:null e o turno
 *      responde com o agente GENÉRICO (decisão do Rafael — não é silêncio).
 *
 *      ⚠️ ESTE DEGRAU DO MEIO NASCEU DE UM DEFEITO MEDIDO (2026-08-18). Antes,
 *      "sem fallback" pulava direto para o genérico — e um router ATIVO com
 *      ZERO membros e sem fallback (estado que a tela deixa criar em dois
 *      cliques, e que classifica nada por construção) sequestrava a sessão
 *      inteira: o agente publicado, com prompt, ferramentas e chave próprios,
 *      deixava de atender TODA mensagem daquele número. Na instalação onde isso
 *      foi medido o genérico caía em `organizations.settings.llm` (provider
 *      'anthropic', sem credencial), então cada turno morria em
 *      `LlmNotConfiguredError`, esgotava as 5 tentativas e virava job morto —
 *      silêncio total, com a tela dizendo "IA atendendo". Um router vazio agora
 *      é inócuo: não casa nada e o número segue atendido por quem estava
 *      publicado.
 *   6. signal null (follow-up, sem mensagem inbound) ⇒ nunca classifica:
 *      sticky se houver, senão fallback, senão genérico.
 *   7. o agente casado (sticky, classificado ou fallback) pode não ter
 *      versão publicada (`loadPublishedAgentConfigById` devolve null) — isso
 *      NUNCA vira outcome de sucesso com config:null (mentira de telemetria,
 *      review T4 finding 4): cai no fallback do router com log.warn, com o
 *      outcome reclassificado honestamente ('fallback'/'no_match'). Se o
 *      PRÓPRIO fallback também não tiver versão publicada, config:null é o
 *      fim legítimo da linha — outcome permanece o que já descrevia a causa.
 *
 * Robustez: qualquer erro inesperado no branch do router (DB fora do ar,
 * shape quebrado) NUNCA derruba o turno — cai no `loadPublishedAgentConfig`
 * de hoje (sem router) com outcome 'classifier_failed' + log.warn. Um lead
 * real está esperando resposta; o router é estritamente aditivo.
 *
 * ⚠️ "silêncio não é desfecho possível" (regra 5) vale para os turnos que
 * CHEGAM aqui. O gate de elegibilidade (migration 0203, canal com
 * `metadata.ai_gate = 'allowlist'`) barra ANTES — no drain e no início do turno,
 * via `decidirElegibilidadeDaConversa` — quando o contato não veio de uma origem
 * elegível. Ali o silêncio É o desfecho, e de propósito.
 */
import type pg from 'pg';

import { CLASSIFIER_CONTEXT_MESSAGES, MAX_CLASSIFIER_CONTEXT_MESSAGES, contextoDoClassificador } from '@/lib/ai/classifier-context';

import { consultarJevNoRoteador } from '@/lib/ai/decisao/roteador';
import type { DependenciasDoPonto } from '@/lib/ai/decisao/ponto';

import type { Logger } from '../obs/logger';
import type { LlmEdgeConfig } from '../edge/llm/run-model-call';
import { agenteDaCampanhaDaConversa } from './agente-da-campanha';
import { registrarDecisaoDoRoteador } from './router-decision-log';
import { loadActiveRouter, type LoadedRouter, type RouterMember } from './router-config';
import {
  loadPublishedAgentConfig,
  loadPublishedAgentConfigById,
  type PublishedAgentConfig,
} from './agent-config';
import { classifyIntent, type ClassifierContextMessage, type IntentVerdict } from './intent-classifier';


export interface TurnAgentResolution {
  config: PublishedAgentConfig | null; // null ⇒ turno segue no genérico (comportamento atual)
  routerId: string | null;
  intentName: string | null;
  confidence: number | null;
  outcome:
    | 'no_router'
    | 'classified'
    | 'sticky'
    | 'reclassified'
    | 'fallback'
    | 'no_match'
    | 'classifier_failed'
    /** A conversa nasceu de uma campanha que declarou agente (migration 0267). */
    | 'campanha';
  /**
   * Fluxo de atendimento que o membro casado aponta (migration 0394; 0237 na branch do autor). O turno
   * começa o fluxo para o contato; `null` = nenhum. Só rótulos casados o trazem
   * — fallback/sem-router NÃO começam fluxo.
   */
  flowPointerId?: string | null;
}

export interface ResolveTurnAgentDeps {
  log: Logger;
  /** Injetável para o teste não precisar de banco. */
  agenteDaCampanha?: typeof agenteDaCampanhaDaConversa;
  loadActiveRouter?: typeof loadActiveRouter;
  loadPublishedAgentConfigById?: typeof loadPublishedAgentConfigById;
  loadPublishedAgentConfig?: typeof loadPublishedAgentConfig;
  classifyIntent?: typeof classifyIntent;
  /** O Jev ao lado do classificador (`lib/ai/decisao/roteador.ts`). */
  consultarJev?: typeof consultarJevNoRoteador;
  /** Chave e `fetch` do Jev — dublês só no teste. Default: a chave da organização e o egress com allowlist. */
  jev?: DependenciasDoPonto;
  registrarDecisao?: typeof registrarDecisaoDoRoteador;
}

/**
 * Regras 2 a 5 sobre UM veredito, sem carregar agente nenhum: o membro que ele
 * escolhe (e com que desfecho), ou o caminho da reserva. É a régua única do
 * roteamento — o turno a aplica ao veredito que decide, e a observação do Jev
 * a aplica aos DOIS vereditos para saber se levariam ao mesmo agente.
 *
 * Um `intentName` fora de `router.members` não casa com ninguém: vale como
 * "nenhuma". O classificador de sempre e o Jev já recusam intenção inventada;
 * isto só impede que um veredito torto vire exceção no meio do turno.
 */
export type DestinoDoVeredito =
  | {
      membro: RouterMember;
      outcome: 'sticky' | 'classified' | 'reclassified';
      intentName: string | null;
      confidence: number | null;
    }
  | { membro: null; outcome: 'no_match' | 'classifier_failed'; confidence: number | null };

/** Mesma condição para dispensar a reserva no turno e na prévia do painel. */
export function vereditoConfiavelDoRoteador(router: LoadedRouter, verdict: IntentVerdict | null): boolean {
  return verdict !== null && verdict.falhou !== true && verdict.intentName !== null &&
    verdict.confidence >= router.minConfidence &&
    router.members.some((m) => m.intentName === verdict.intentName);
}

export function destinoDoVeredito(
  router: LoadedRouter,
  stickyMember: RouterMember | undefined,
  stickyIntent: string | null,
  verdict: IntentVerdict | null,
): DestinoDoVeredito {
  // regra 4: classificador falhou — um `null` é informação mais pobre que
  // "sem sinal", nunca deve derrubar a stickiness (review T4 finding 1).
  if (verdict === null) {
    if (stickyMember !== undefined) {
      return { membro: stickyMember, outcome: 'sticky', intentName: stickyIntent, confidence: null };
    }
    return { membro: null, outcome: 'classifier_failed', confidence: null };
  }

  const casado =
    verdict.intentName !== null && verdict.confidence >= router.minConfidence
      ? router.members.find((m) => m.intentName === verdict.intentName)
      : undefined;

  if (stickyMember !== undefined) {
    // regra 2: só troca se a intenção vier DIFERENTE da sticky, com confiança.
    if (casado === undefined || verdict.intentName === stickyIntent) {
      return { membro: stickyMember, outcome: 'sticky', intentName: stickyIntent, confidence: verdict.confidence };
    }
    return { membro: casado, outcome: 'reclassified', intentName: verdict.intentName, confidence: verdict.confidence };
  }

  // sem sticky (regra 3).
  if (casado !== undefined) {
    return { membro: casado, outcome: 'classified', intentName: verdict.intentName, confidence: verdict.confidence };
  }
  return { membro: null, outcome: 'no_match', confidence: verdict.confidence };
}

/**
 * O agente a que o destino leva, para comparar o Jev com a IA de sempre: o do
 * membro, senão o de reserva do roteador, senão `fallback` — o publicado da
 * sessão, o mesmo para os dois lados.
 * ponytail: sem carregar a versão publicada (regra 7). Um membro sem versão
 * publicada cai na reserva no turno e conta aqui pelo id dele; os dois lados
 * erram igual, e só o caso "um escolheu esse membro, o outro a reserva" sai
 * como discordância. Carregar os dois agentes a cada turno custaria mais que isso.
 */
export function agenteDoDestino(router: LoadedRouter, destino: DestinoDoVeredito): string {
  return destino.membro?.agentId ?? router.fallbackAgentId ?? 'fallback';
}

export async function resolveTurnAgent(
  db: pg.Pool,
  llmCfg: LlmEdgeConfig,
  input: {
    tenantId: string;
    leadId: string;
    jobId: string;
    channelSessionId: string;
    conversationId: string;
    signal: string | null;
    /** A mensagem de onde o `signal` saiu — amarra a observação do Jev a ela. */
    signalMessageId?: string | null;
    stickyAgentId: string | null;
    stickyIntent: string | null;
    /** Mensagens anteriores ao signal, mais antiga → mais recente. Default []. */
    recentMessages?: ClassifierContextMessage[];
  },
  deps: ResolveTurnAgentDeps,
): Promise<TurnAgentResolution> {
  const inicioDoRoteamento = Date.now();
  const _loadActiveRouter = deps.loadActiveRouter ?? loadActiveRouter;
  const _loadAgentById = deps.loadPublishedAgentConfigById ?? loadPublishedAgentConfigById;
  const _loadAgentBySession = deps.loadPublishedAgentConfig ?? loadPublishedAgentConfig;
  const _classifyIntent = deps.classifyIntent ?? classifyIntent;
  const _consultarJev = deps.consultarJev ?? consultarJevNoRoteador;

  try {
    // ─── Degrau 0: a campanha que criou esta conversa ───
    //
    // ACIMA do roteador de propósito. O roteador é do NÚMERO e classifica
    // assunto; a campanha é a razão de a conversa existir, e ela sabe algo que
    // o classificador não tem como inferir: que esta pessoa está respondendo a
    // uma abordagem, e que quem aborda segue outro roteiro.
    //
    // Falha ABERTA: agente da campanha sem versão publicada devolve `null` em
    // `_loadAgentById`, e o turno segue pela régua normal em vez de calar.
    const _agenteDaCampanha = deps.agenteDaCampanha ?? agenteDaCampanhaDaConversa;
    const idDaCampanha = await _agenteDaCampanha(db, input.tenantId, input.conversationId);
    if (idDaCampanha !== null) {
      const config = await _loadAgentById(db, input.tenantId, idDaCampanha);
      if (config !== null) {
        return { config, routerId: null, intentName: null, confidence: null, outcome: 'campanha' };
      }
      deps.log.warn('agente da campanha sem versão publicada; seguindo pela régua do número', {
        tenantId: input.tenantId,
        conversationId: input.conversationId,
      });
    }

    const router = await _loadActiveRouter(db, input.tenantId, input.channelSessionId);
    if (router === null) {
      return {
        config: await _loadAgentBySession(db, input.tenantId, input.channelSessionId),
        routerId: null,
        intentName: null,
        confidence: null,
        outcome: 'no_router',
      };
    }

    // fallback do router ou genérico — usado pelas regras 4, 5, 6 e 7.
    const resolveFallback = async (
      outcome: 'no_match' | 'classifier_failed',
      confidence: number | null,
    ): Promise<TurnAgentResolution> => {
      if (router.fallbackAgentId === null) {
        // Regra 5: sem fallback declarado, quem atende é o agente publicado da
        // SESSÃO — o comportamento de antes do router existir. `null` aqui
        // (nenhum publicado) segue caindo no genérico, como sempre.
        const daSessao = await _loadAgentBySession(db, input.tenantId, input.channelSessionId);
        if (daSessao === null) {
          deps.log.warn('resolve-turn-agent: router sem fallback e sessão sem agente publicado — turno cai no genérico', {
            routerId: router.id,
            outcome,
          });
        }
        return { config: daSessao, routerId: router.id, intentName: null, confidence, outcome };
      }
      const config = await _loadAgentById(db, input.tenantId, router.fallbackAgentId);
      if (config === null) {
        // regra 7: fallback também sem versão publicada — fim legítimo da
        // linha, mas o outcome que já explicava a causa (classifier_failed)
        // não vira 'no_match' por engano; só rebaixa quando o motivo era
        // genuinamente "sem match", pra não mentir sobre o que aconteceu.
        deps.log.warn('resolve-turn-agent: fallbackAgentId sem versão publicada — turno cai no genérico', {
          routerId: router.id,
          fallbackAgentId: router.fallbackAgentId,
        });
      }
      return {
        config,
        routerId: router.id,
        intentName: null,
        confidence,
        outcome: outcome === 'classifier_failed' ? 'classifier_failed' : config === null ? 'no_match' : 'fallback',
      };
    };

    // carrega o agente casado (sticky/classificado/reclassificado); se ele não
    // tiver versão publicada, NUNCA devolve outcome de sucesso com config:null
    // (mentiria pra telemetria — review T4 finding 4) — cai no fallback do
    // router com log.warn, honesto sobre a causa real.
    const loadMatchedOrFallback = async (
      outcome: 'sticky' | 'classified' | 'reclassified',
      member: RouterMember,
      intentName: string | null,
      confidence: number | null,
    ): Promise<TurnAgentResolution> => {
      const agentId = member.agentId;
      const config = await _loadAgentById(db, input.tenantId, agentId);
      if (config === null) {
        deps.log.warn('resolve-turn-agent: agente casado sem versão publicada — tentando fallback do router', {
          routerId: router.id,
          matchedOutcome: outcome,
          agentId,
        });
        return resolveFallback('no_match', confidence);
      }
      return {
        config,
        routerId: router.id,
        intentName,
        confidence,
        outcome,
        // Só a intenção casada AGORA começa roteiro. Sticky é o mesmo assunto da
        // conversa em curso: devolvê-lo recomeçaria o roteiro a cada turno — e,
        // depois de concluído, de novo, para sempre.
        flowPointerId: outcome === 'sticky' ? null : (member.flowPointerId ?? null),
      };
    };

    // sticky elegível: config liga sticky E o agente ainda é membro do router
    // (membro removido ⇒ trata como sem sticky, decisão segura — ver report).
    const stickyMember =
      router.sticky && input.stickyAgentId !== null
        ? router.members.find((m) => m.agentId === input.stickyAgentId)
        : undefined;

    // regra 6: sem mensagem inbound (follow-up) — nunca classifica.
    if (input.signal === null) {
      if (stickyMember !== undefined) {
        return loadMatchedOrFallback('sticky', stickyMember, input.stickyIntent, null);
      }
      return resolveFallback('no_match', null);
    }

    // O Jev pergunta em paralelo, com contexto recente somente sob aceite específico.
    // Observando, o turno não espera por ele.
    const recentMessages = contextoDoClassificador(input.recentMessages ?? [], router.contextMessageCount ?? CLASSIFIER_CONTEXT_MESSAGES);
    const jev = _consultarJev(
      db,
      {
        organizationId: input.tenantId,
        mensagem: input.signal,
        recentMessages,
        contextMessageCount: router.contextMessageCount ?? CLASSIFIER_CONTEXT_MESSAGES,
        membros: router.members,
        contactId: input.leadId,
        jobId: input.jobId,
      },
      deps.jev,
    );

    // Em comparação, a classificação convencional começa em paralelo com o Jev.
    // Sob demanda, só há esta chamada se o Jev não trouxer intenção confiável.
    const modo = await (jev.modo ?? Promise.resolve('comparacao'));
    const estadoLido = await jev.estado;
    const limiteConsentido = await (jev.contextoMaximo ?? Promise.resolve(null));
    const contextoTradicional = estadoLido !== 'desligada' && limiteConsentido === 4
      ? contextoDoClassificador(recentMessages, 4) : recentMessages;
    const classificar = () => _classifyIntent(
      db, llmCfg,
      { tenantId: input.tenantId, leadId: input.leadId, jobId: input.jobId, router, signal: input.signal!, recentMessages: contextoTradicional },
      { log: deps.log },
    );
    const independente = modo === 'sob_demanda' && estadoLido === 'decidindo';
    const comparacao = independente ? null : classificar();
    const escolhaIndependente = independente ? await jev.escolha : null;
    const jevConfiavel = vereditoConfiavelDoRoteador(router, escolhaIndependente?.veredito ?? null);
    const verdict = comparacao !== null ? await comparacao : jevConfiavel ? null : await classificar();

    // Decidindo, vale a escolha do Jev, e a IA de sempre é a reserva. Sem a IA
    // de sempre (a chamada falhou, a saída não era resposta, ou a empresa não
    // tem uma), vale a regra de hoje, nunca o Jev (R2) — e aí nem se espera por
    // ele. A saída ilegível segue sendo "nenhuma" para o roteamento de hoje
    // (sticky ou `no_match`); só não conta como a IA ter respondido: um modelo
    // que nunca devolve JSON deixaria o Jev rotear sozinho, sem alarme.
    const iaRespondeu = verdict !== null && verdict.falhou !== true;
    const estadoDoJev = independente ? 'decidindo' : iaRespondeu ? await jev.estado : null;
    const doJev = independente
      ? jevConfiavel ? escolhaIndependente : null
      : estadoDoJev === 'decidindo' ? await jev.escolha : null;
    const destino = destinoDoVeredito(router, stickyMember, input.stickyIntent, doJev?.veredito ?? verdict);

    jev.observar({
      conversationId: input.conversationId,
      messageId: input.signalMessageId ?? null,
      rotuloDe: (v) => agenteDoDestino(router, destinoDoVeredito(router, stickyMember, input.stickyIntent, v)),
      // Sem resposta da IA não há par: a linha fica sem o lado dela, fora da concordância.
      // Reservas são uma amostra selecionada por falha/baixa confiança, não
      // um par comparativo. Também ficam fora do indicador antigo do cartão.
      vereditoDaIa: !independente && iaRespondeu ? verdict : null,
      decidiu: doJev !== null,
      // Decidindo, sem a escolha dele, valeu a da IA de sempre: é cobertura, e ela deixa rastro.
      aIaCobriu: estadoDoJev === 'decidindo' && doJev === null && iaRespondeu,
    });

    const resultado = await (destino.membro !== null
      ? loadMatchedOrFallback(destino.outcome, destino.membro, destino.intentName, destino.confidence)
      : resolveFallback(destino.outcome, destino.confidence));
    const motivoReserva = !independente || jevConfiavel ? null
      : escolhaIndependente === null ? 'falha_jev'
      : escolhaIndependente.veredito.intentName === null ? 'sem_intencao'
      : escolhaIndependente.veredito.confidence < router.minConfidence ? 'baixa_confianca'
      : 'intencao_invalida';
    await (deps.registrarDecisao ?? registrarDecisaoDoRoteador)(db, {
      organizationId: input.tenantId, routerId: router.id, conversationId: input.conversationId,
      messageId: input.signalMessageId ?? null, jobId: input.jobId,
      modo: independente ? 'jev_sob_demanda' : estadoLido === 'decidindo' ? 'jev_comparacao' : 'tradicional_comparacao',
      contextMessageCount: contextoTradicional.length,
      origem: independente ? doJev ? 'jev' : 'reserva' : doJev ? 'jev' : 'tradicional',
      motivoReserva,
      intentJev: escolhaIndependente?.veredito.intentName ?? doJev?.veredito.intentName ?? null,
      intentTradicional: verdict?.intentName ?? null,
      jev: escolhaIndependente ?? doJev,
      jevSolicitado: estadoLido !== 'desligada',
      chamouTradicional: comparacao !== null || !jevConfiavel,
      resultado,
      tempoTotalMs: Date.now() - inicioDoRoteamento,
    });
    return resultado;
  } catch (err) {
    deps.log.warn('resolve-turn-agent: erro inesperado no router — turno cai no fluxo sem router', {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      config: await _loadAgentBySession(db, input.tenantId, input.channelSessionId),
      routerId: null,
      intentName: null,
      confidence: null,
      outcome: 'classifier_failed',
    };
  }
}

/** One read-only selection before operation policy. A real queue job supplies correlation. */
export async function resolveConversationTurn(
  db: pg.Pool,
  llmCfg: LlmEdgeConfig,
  input: {
    tenantId: string;
    leadId: string;
    jobId: string;
    conversationId: string;
    channelSessionId: string;
    inbound: boolean;
  },
  deps: ResolveTurnAgentDeps,
): Promise<TurnAgentResolution> {
  const { rows } = await db.query<{
    active_ai_agent_id: string | null;
    active_intent: string | null;
  }>(
    'select active_ai_agent_id,active_intent from conversations where organization_id=$1 and id=$2',
    [input.tenantId, input.conversationId],
  );
  const signalRow = input.inbound
    ? (await db.query<{ id: string; body: string | null }>(
        "select id,body from messages where organization_id=$1 and conversation_id=$2 and direction='inbound' order by sent_at desc,created_at desc,id desc limit 1",
        [input.tenantId, input.conversationId],
      )).rows[0] ?? null
    : null;
  const signal = signalRow?.body ?? null;

  // Contexto curto pro CLASSIFICADOR (regra 2 abaixo desambigua resposta
  // curta em meio a fluxo) — nunca o histórico completo. Só busca quando há
  // signal: sem inbound (regra 6) o classificador nem roda.
  let recentMessages: ClassifierContextMessage[] = [];
  if (signalRow !== null && signal !== null) {
    const { rows: contextRows } = await db.query<ClassifierContextMessage>(
      `select direction,body from messages
       where organization_id=$1 and conversation_id=$2 and body is not null and id<>$3
       order by sent_at desc,created_at desc,id desc limit $4`,
      [input.tenantId, input.conversationId, signalRow.id, MAX_CLASSIFIER_CONTEXT_MESSAGES],
    );
    recentMessages = contextRows.reverse();
  }

  return resolveTurnAgent(db, llmCfg, {
    ...input,
    signal,
    signalMessageId: signalRow?.id ?? null,
    recentMessages,
    stickyAgentId: rows[0]?.active_ai_agent_id ?? null,
    stickyIntent: rows[0]?.active_intent ?? null,
  }, deps);
}
