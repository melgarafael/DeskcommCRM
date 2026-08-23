/**
 * Classificador de intenção do Intent Router (Fase 3 — Task 3). Roda um modelo
 * (router.classifierModel, config da org via ai_routers — `null` = herda
 * modelo+provider default da organização) pelo MESMO seam agnóstico
 * (runModelCall, purpose 'intent_router') pra decidir pra qual agente do
 * router o turno deve ir. Mesmo padrão de stage-classifier.ts: o classificador
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
}

/** Instrução final fixa — pede JSON estrito, marcador estável pros testes/prompt. */
const JSON_INSTRUCTION =
  'Responda SOMENTE JSON: {"intent": "<nome exato de uma intenção da lista ou none>", "confidence": <0 a 1>}';

export function buildClassifierPrompt(members: RouterMember[], signal: string): string {
  const list = members
    .map((m) => {
      const examples = m.examples.length > 0 ? ` Exemplos: ${m.examples.join('; ')}.` : '';
      return `- ${m.intentName}: ${m.intentDescription}.${examples}`;
    })
    .join('\n');
  return [
    'Você é um classificador auxiliar de intenção (NÃO responde ao lead).',
    'Intenções possíveis:',
    list,
    '- none: nenhuma das intenções acima se aplica.',
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
  const nullVerdict: IntentVerdict = { intentName: null, confidence: 0 };
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

  if (typeof raw.intent !== 'string' || raw.intent === 'none') {
    return { intentName: null, confidence };
  }
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
        // `classifierModel`/`classifierProvider` são lidos como PAR por
        // router-config.ts — sem os dois, ambos null aqui, e omitir `model`
        // faz o seam herdar defaultModel+provider da org (sempre consistentes
        // entre si). Mandar um `model` solto sem o provider correspondente é o
        // defeito de origem (PR #151): id válido para o provider errado.
        ...(input.router.classifierModel ? { model: input.router.classifierModel } : {}),
        ...(input.router.classifierProvider
          ? { llmOverride: { provider: input.router.classifierProvider } }
          : {}),
        messages: [{ role: 'user', content: buildClassifierPrompt(input.router.members, input.signal) }],
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
