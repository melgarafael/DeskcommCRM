/**
 * Classificador + decisor de instante do sistema de fluxos de follow-up (onda 5,
 * Task 5.1) — os dois `purpose` de `followup_turn` dirigido por fluxo que NÃO
 * rodam o agente inteiro (`classify`/`decide_timing`): uma ÚNICA chamada de
 * modelo pelo seam agnóstico (runModelCall), mesmo padrão de
 * stage-classifier.ts/guardrails/promise/semantic.ts.
 *
 * Quem decide o que fazer com o resultado é a PONTE
 * (lib/followup/turn-bridge.ts, via callback injetado em followup-turn.ts) —
 * este módulo só classifica/propõe, nunca escreve no enrollment.
 */
import type pg from 'pg';

import type { Logger } from '../obs/logger';
import type { ProviderRegistry } from '../edge/llm/providers';
import { runModelCall, type LlmEdgeConfig } from '../edge/llm/run-model-call';
import type { LeadContext } from '../edge/crm/get-lead-context';

const CLASSIFY_INSTRUCTION =
  'Você é um classificador auxiliar de follow-up (NÃO responde ao lead). Classifique a ' +
  'ÚLTIMA mensagem do lead abaixo em UMA das classes listadas. Responda SOMENTE com JSON, ' +
  'sem explicação: {"class": "<uma das classes, exatamente como listada>"}.';

function buildClassifyMessage(candidate: string, classes: string[], hint?: string): string {
  return [
    CLASSIFY_INSTRUCTION,
    '',
    '## Classes possíveis',
    classes.map((c) => `- ${c}`).join('\n'),
    ...(hint ? ['', '## Dica adicional do fluxo', hint] : []),
    '',
    '## Mensagem do lead a classificar',
    candidate,
  ].join('\n');
}

/**
 * Extrai `class` do JSON do modelo (tolerante a prosa/cerca em volta). Só aceita
 * uma classe que esteja literalmente em `classes` — saída fora da lista (ou sem
 * JSON parseável) vira `null`, nunca um palpite.
 */
export function parseFollowupClassification(text: string, classes: string[]): string | null {
  const match = /\{[\s\S]*\}/.exec(text);
  if (match === null) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
  const value = typeof obj.class === 'string' ? obj.class : null;
  return value !== null && classes.includes(value) ? value : null;
}

/**
 * Classifica a última resposta do lead em uma de `classes`. `candidateText` já
 * vem resolvido pelo chamador como "a última inbound DEPOIS do último
 * outbound, ou null" — sem candidato, NÃO chama o modelo: devolve 'no_reply'
 * direto (custo $0; espelha o caminho sem LLM de node-handlers.ts na expiração
 * de grace). Saída não-parseável/fora de `classes` → erro (o job re-tenta pela
 * fila; nunca adivinha uma classe errada — doutrina "sem preguiça").
 */
export async function classifyFollowupReply(
  db: pg.Pool,
  cfg: LlmEdgeConfig,
  ids: { tenantId: string; leadId: string; jobId: string },
  args: { candidateText: string | null; classes: string[]; hint?: string; model?: string },
  deps: { registry?: ProviderRegistry; log: Logger },
): Promise<string> {
  if (args.candidateText === null) return 'no_reply';

  const call = await runModelCall(
    db,
    cfg,
    {
      tenantId: ids.tenantId,
      leadId: ids.leadId,
      jobId: ids.jobId,
      purpose: 'followup_classify',
      ...(args.model !== undefined ? { model: args.model } : {}),
      messages: [{ role: 'user', content: buildClassifyMessage(args.candidateText, args.classes, args.hint) }],
    },
    { registry: deps.registry, log: deps.log },
  );
  const cls = parseFollowupClassification(call.result.text, args.classes);
  if (cls === null) {
    throw new Error(
      'classificador de follow-up: saída do modelo sem classe reconhecível dentre as configuradas — turno re-tentado pela fila',
    );
  }
  return cls;
}

const TIMING_INSTRUCTION =
  'Você é um planejador auxiliar de follow-up (NÃO responde ao lead). Com base no contexto ' +
  'do lead e na orientação abaixo, proponha o MELHOR instante para retomar contato. ' +
  'Responda SOMENTE com JSON, sem explicação: ' +
  '{"proposed_at": "<instante ISO-8601 UTC, ex: 2026-07-25T14:00:00.000Z>"}.';

function buildTimingMessage(context: LeadContext, now: Date, guidance: string | undefined): string {
  return [
    TIMING_INSTRUCTION,
    '',
    '## Agora',
    now.toISOString(),
    ...(guidance ? ['', '## Orientação do fluxo', guidance] : []),
    '',
    '## Contexto do lead (contato + últimas mensagens)',
    JSON.stringify(context),
  ].join('\n');
}

/** Extrai `proposed_at` do JSON do modelo — só aceita um instante ISO parseável. */
export function parseProposedAt(text: string): string | null {
  const match = /\{[\s\S]*\}/.exec(text);
  if (match === null) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
  const value = typeof obj.proposed_at === 'string' ? obj.proposed_at : null;
  return value !== null && !Number.isNaN(Date.parse(value)) ? value : null;
}

/**
 * Propõe o instante (ISO) para retomar um `wait` smart, dado o contexto do
 * lead + a orientação do nó. A PONTE (turn-bridge.ts) é quem clampa o
 * resultado em `[min_ms, max_ms]` — este módulo só propõe, nunca decide o
 * range nem escreve no enrollment.
 */
export async function decideFollowupTiming(
  db: pg.Pool,
  cfg: LlmEdgeConfig,
  ids: { tenantId: string; leadId: string; jobId: string },
  args: { context: LeadContext; guidance?: string; model?: string },
  deps: { registry?: ProviderRegistry; log: Logger; clock?: () => Date },
): Promise<string> {
  const now = (deps.clock ?? ((): Date => new Date()))();
  const call = await runModelCall(
    db,
    cfg,
    {
      tenantId: ids.tenantId,
      leadId: ids.leadId,
      jobId: ids.jobId,
      purpose: 'followup_decide_timing',
      ...(args.model !== undefined ? { model: args.model } : {}),
      messages: [{ role: 'user', content: buildTimingMessage(args.context, now, args.guidance) }],
    },
    { registry: deps.registry, log: deps.log },
  );
  const proposed = parseProposedAt(call.result.text);
  if (proposed === null) {
    throw new Error(
      'decisor de instante de follow-up: saída do modelo sem instante ISO reconhecível — turno re-tentado pela fila',
    );
  }
  return proposed;
}
