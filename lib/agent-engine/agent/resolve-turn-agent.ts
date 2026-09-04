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

import type { Logger } from '../obs/logger';
import type { LlmEdgeConfig } from '../edge/llm/run-model-call';
import { loadActiveRouter } from './router-config';
import {
  loadPublishedAgentConfig,
  loadPublishedAgentConfigById,
  type PublishedAgentConfig,
} from './agent-config';
import { classifyIntent } from './intent-classifier';

export interface TurnAgentResolution {
  config: PublishedAgentConfig | null; // null ⇒ turno segue no genérico (comportamento atual)
  routerId: string | null;
  intentName: string | null;
  confidence: number | null;
  outcome: 'no_router' | 'classified' | 'sticky' | 'reclassified' | 'fallback' | 'no_match' | 'classifier_failed';
}

export interface ResolveTurnAgentDeps {
  log: Logger;
  loadActiveRouter?: typeof loadActiveRouter;
  loadPublishedAgentConfigById?: typeof loadPublishedAgentConfigById;
  loadPublishedAgentConfig?: typeof loadPublishedAgentConfig;
  classifyIntent?: typeof classifyIntent;
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
    stickyAgentId: string | null;
    stickyIntent: string | null;
  },
  deps: ResolveTurnAgentDeps,
): Promise<TurnAgentResolution> {
  const _loadActiveRouter = deps.loadActiveRouter ?? loadActiveRouter;
  const _loadAgentById = deps.loadPublishedAgentConfigById ?? loadPublishedAgentConfigById;
  const _loadAgentBySession = deps.loadPublishedAgentConfig ?? loadPublishedAgentConfig;
  const _classifyIntent = deps.classifyIntent ?? classifyIntent;

  try {
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
      agentId: string,
      intentName: string | null,
      confidence: number | null,
    ): Promise<TurnAgentResolution> => {
      const config = await _loadAgentById(db, input.tenantId, agentId);
      if (config === null) {
        deps.log.warn('resolve-turn-agent: agente casado sem versão publicada — tentando fallback do router', {
          routerId: router.id,
          matchedOutcome: outcome,
          agentId,
        });
        return resolveFallback('no_match', confidence);
      }
      return { config, routerId: router.id, intentName, confidence, outcome };
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
        return loadMatchedOrFallback('sticky', stickyMember.agentId, input.stickyIntent, null);
      }
      return resolveFallback('no_match', null);
    }

    // classifica — inclusive com sticky ativo, pra detectar troca de assunto (regra 2).
    const verdict = await _classifyIntent(
      db,
      llmCfg,
      { tenantId: input.tenantId, leadId: input.leadId, jobId: input.jobId, router, signal: input.signal },
      { log: deps.log },
    );

    // regra 4: classificador falhou — um `null` é informação mais pobre que
    // "sem sinal", nunca deve derrubar a stickiness (review T4 finding 1).
    if (verdict === null) {
      if (stickyMember !== undefined) {
        return loadMatchedOrFallback('sticky', stickyMember.agentId, input.stickyIntent, null);
      }
      return resolveFallback('classifier_failed', null);
    }

    if (stickyMember !== undefined) {
      const changedSubject =
        verdict.intentName !== null && verdict.intentName !== input.stickyIntent && verdict.confidence >= router.minConfidence;
      if (!changedSubject) {
        return loadMatchedOrFallback('sticky', stickyMember.agentId, input.stickyIntent, verdict.confidence);
      }
      const newMember = router.members.find((m) => m.intentName === verdict.intentName);
      // newMember sempre definido: classifyIntent só devolve intentName que bateu em router.members.
      return loadMatchedOrFallback('reclassified', newMember!.agentId, verdict.intentName, verdict.confidence);
    }

    // sem sticky (regra 3).
    if (verdict.intentName !== null && verdict.confidence >= router.minConfidence) {
      const member = router.members.find((m) => m.intentName === verdict.intentName);
      return loadMatchedOrFallback('classified', member!.agentId, verdict.intentName, verdict.confidence);
    }

    return resolveFallback('no_match', verdict.confidence);
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
