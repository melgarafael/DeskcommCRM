/**
 * Classificador de intenção do Intent Router (Fase 3 — Task 3). Roda um modelo
 * BARATO (router.classifierModel, config da org via ai_routers) pelo MESMO seam
 * agnóstico (runModelCall, purpose 'intent_router') pra decidir pra qual agente
 * do router o turno deve ir. Mesmo padrão de stage-classifier.ts: o classificador
 * SUGERE, nunca escreve estado — quem decide o roteamento é o chamador (Task 4).
 *
 * Defesa contra saída de modelo (não-confiável): parseIntentVerdict NUNCA lança —
 * JSON malformado, campo faltando, intenção alucinada (fora da lista de members
 * do router) ou confidence fora de [0,1]/não-numérico tudo vira veredito nulo
 * ({ intentName: null, confidence: 0 }). classifyIntent embrulha tudo em
 * try/catch: qualquer erro (falha do modelo, LlmModelNotEnabledError, timeout)
 * vira log.warn + null — o chamador cai no fallbackAgentId do router.
 */
import type pg from 'pg';

import type { Logger } from '../obs/logger';
import { runModelCall, type LlmEdgeConfig } from '../edge/llm/run-model-call';
import type { LoadedRouter, RouterMember } from './router-config';

export interface IntentVerdict {
  intentName: string | null;
  confidence: number;
  /**
   * A saída não era uma resposta: sem JSON, JSON inválido, sem intenção, ou uma
   * intenção fora da lista. O roteamento de hoje a lê como "nenhuma" (sticky ou
   * `no_match`), e isso não muda; o que muda é que ninguém a trata como uma
   * escolha da IA — o Jev decidindo não vale no lugar dela (R2), como na
   * manipulação (`classifyJailbreak`, `falhou`).
   */
  falhou?: true;
}

/** Mensagem de contexto anterior à atual — só pra desambiguar, nunca o alvo da classificação. */
export interface ClassifierContextMessage {
  direction: 'inbound' | 'outbound';
  body: string;
}

/** Instrução final fixa — pede JSON estrito, marcador estável pros testes/prompt. */
const JSON_INSTRUCTION =
  'Responda SOMENTE JSON: {"intent": "<nome exato de uma intenção da lista ou none>", "confidence": <0 a 1>}';

/**
 * `recentMessages` é histórico curto (poucas mensagens, mais antiga → mais
 * recente), NUNCA a conversa inteira: o classificador roda em TODO turno,
 * inclusive com sticky ativo (resolve-turn-agent.ts regra 2), então o custo é
 * por mensagem — histórico completo pagaria esse preço a cada turno pra um
 * modelo cuja única pergunta é "mudou de assunto?". Existe só pra resolver
 * ambiguidade de resposta curta (“Primeira”, “sim”) que sem a pergunta
 * anterior parece bater em qualquer intenção — não pra dar memória ao
 * classificador.
 */
export function buildClassifierPrompt(
  members: RouterMember[],
  signal: string,
  recentMessages: ClassifierContextMessage[] = [],
): string {
  const list = members
    .map((m) => {
      const examples = m.examples.length > 0 ? ` Exemplos: ${m.examples.join('; ')}.` : '';
      return `- ${m.intentName}: ${m.intentDescription}.${examples}`;
    })
    .join('\n');
  const contexto =
    recentMessages.length > 0
      ? [
          '',
          'Contexto recente da conversa (mais antiga primeiro — só pra desambiguar, NÃO é o que classificar):',
          ...recentMessages.map((m) => `${m.direction === 'inbound' ? 'Lead' : 'Agente'}: ${m.body}`),
        ]
      : [];
  return [
    'Você é um classificador auxiliar de intenção (NÃO responde ao lead).',
    'Intenções possíveis:',
    list,
    '- none: nenhuma das intenções acima se aplica.',
    ...contexto,
    '',
    'Mensagem do lead a classificar:',
    signal,
    '',
    JSON_INSTRUCTION,
  ].join('\n');
}

/**
 * Parse tolerante (padrão de flywheel/live.ts): indexOf('{')/lastIndexOf('}') +
 * JSON.parse em try/catch. NUNCA lança — qualquer saída inesperada do modelo
 * vira { intentName: null, confidence: 0 }. Intenção fora de `members` é
 * recusada (defesa contra alucinação): o chamador não pode rotear pra um
 * agentId que o parse inventou.
 */
export function parseIntentVerdict(text: string, members: RouterMember[]): IntentVerdict {
  const nullVerdict: IntentVerdict = { intentName: null, confidence: 0, falhou: true };
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return nullVerdict;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return nullVerdict;
  }
  if (typeof parsed !== 'object' || parsed === null) return nullVerdict;

  const raw = parsed as { intent?: unknown; confidence?: unknown };
  const confidence = typeof raw.confidence === 'number' && !Number.isNaN(raw.confidence)
    ? Math.min(1, Math.max(0, raw.confidence))
    : 0;

  if (typeof raw.intent !== 'string') return nullVerdict;
  if (raw.intent === 'none') return { intentName: null, confidence };
  const known = members.some((m) => m.intentName === raw.intent);
  if (!known) return nullVerdict;

  return { intentName: raw.intent, confidence };
}

export interface ClassifyIntentDeps {
  log: Logger;
  runModelCall?: typeof runModelCall;
}

export async function classifyIntent(
  db: pg.Pool,
  llmCfg: LlmEdgeConfig,
  input: {
    tenantId: string;
    /** null quando não há contact_id real (ex.: classificação de teste na UI) — vira contact_id null em llm_calls, nunca um uuid inventado (violaria a FK). */
    leadId: string | null;
    /** null quando não há job_queue real por trás da chamada (mesma razão de leadId). */
    jobId: string | null;
    router: LoadedRouter;
    signal: string;
    /** Últimas mensagens ANTERIORES ao signal, mais antiga → mais recente. Default []. */
    recentMessages?: ClassifierContextMessage[];
  },
  deps: ClassifyIntentDeps,
): Promise<IntentVerdict | null> {
  const call = deps.runModelCall ?? runModelCall;
  try {
    const { result } = await call(
      db,
      llmCfg,
      {
        tenantId: input.tenantId,
        leadId: input.leadId,
        jobId: input.jobId,
        purpose: 'intent_router',
        // Sem modelo próprio ("Automático"), não passa nenhum: o seam resolve
        // pelo painel de provedores ou pelo padrão da organização.
        ...(input.router.classifierModel ? { model: input.router.classifierModel } : {}),
        // Sem isto, o modelo do roteador viaja para o provedor da ORG: escolher
        // um modelo OpenAI numa org configurada como Anthropic mandava o id para
        // o lugar errado, e a classificação falhava sempre.
        ...(input.router.classifierProvider
          ? { llmOverride: { provider: input.router.classifierProvider } }
          : {}),
        messages: [
          {
            role: 'user',
            content: buildClassifierPrompt(input.router.members, input.signal, input.recentMessages ?? []),
          },
        ],
      },
      { log: deps.log },
    );
    return parseIntentVerdict(result.text, input.router.members);
  } catch (err) {
    // Falha do classificador NUNCA derruba o turno — chamador cai no fallback do router.
    deps.log.warn('intent-classifier: falha ao classificar intenção — turno cai no fallback', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
