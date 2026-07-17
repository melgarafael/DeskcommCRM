/**
 * Compaction + rolling summary com flush pré-compaction (F3-07; blueprint órgão 2,
 * OpenClaw 1.5 — "a ideia de maior alavancagem"). Quando o histórico do lead cresce
 * além do limiar (knob), o turno COMPACTA a conversa num resumo estruturado com um
 * MODELO BARATO auxiliar (via o seam agnóstico F2-23 — override de `model`, NÃO
 * roteamento do modelo do agente; budget da org checado ANTES da chamada dentro de
 * runModelCall). A saída estruturada preserva compromissos, objeções, dados pessoais
 * citados e o estágio; ela vira o rolling summary injetado no SUFIXO do prompt e o
 * transcript integral é trocado por uma cauda recente sob orçamento (regra dura 15 do
 * CLAUDE.md — nunca transcript integral no prompt; o rolling summary durável segue no
 * checkpoint de fechamento).
 *
 * ANTES da compaction, um FLUSH silencioso (turno interno, não é resposta ao lead)
 * extrai os fatos DURÁVEIS e os persiste em lead_notes (F3-05) — o padrão de maior
 * alavancagem: a memória durável é gravada ANTES de a compaction descartar o contexto.
 * A ordem é observável (o flush chama o modelo e grava as notas antes de a compaction
 * rodar). Hard cap do índice de notas (F3-05): se uma nota do flush estoura o orçamento,
 * loga LOUD e segue — o flush é best-effort e NUNCA derruba o turno nem engole em
 * silêncio; a consolidação fica para o agente (supersedes) num turno futuro.
 *
 * tenant_id/lead_id vêm da ROW do job (closure do run), nunca do payload (regra dura 1).
 * PII: as notas e o transcript VÃO ao modelo (é o ponto), mas NUNCA entram em log — os
 * logs só carregam contagens/códigos.
 */
import { z } from 'zod';
import type pg from 'pg';

import type { Logger } from '../obs/logger';
import type { ProviderRegistry } from '../edge/llm/providers';
import { runModelCall, type LlmEdgeConfig } from '../edge/llm/run-model-call';
import { countPayloadTokens, type LeadContext, type LeadContextMessage } from '../edge/crm/get-lead-context';
import { applySaveLeadNote } from './lead-notes';

/** Knobs da compaction (env COMPACTION_*; defaults conservadores no .env.example). */
export interface CompactionKnobs {
  /** dispara quando o histórico tem ≥ este nº de mensagens (COMPACTION_TRIGGER_MESSAGES). */
  triggerMessages: number;
  /**
   * modelo auxiliar BARATO do flush+compaction (COMPACTION_MODEL). Resolvido pela camada
   * agnóstica (override de `model` no seam) — NUNCA um id hardcoded; sujeito a
   * enabled_models da org quando a lista não é vazia. Ausente = usa o defaultModel da org
   * (fallback seguro do seam).
   */
  model?: string;
  /** orçamento (tokens) do transcript que sobra no prompt após compactar (COMPACTION_TRANSCRIPT_MAX_TOKENS). */
  transcriptMaxTokens: number;
}

/** Instrução FIXA do flush — marcador estável (como CHECKPOINT_INSTRUCTION) para os testes. */
export const FLUSH_INSTRUCTION =
  'Turno interno de memória (NÃO é resposta ao lead). A conversa acima vai ser compactada e o ' +
  'histórico detalhado será descartado. ANTES disso, extraia os fatos DURÁVEIS que valem lembrar ' +
  'em conversas futuras: preferências, contexto pessoal, restrições, o que já foi oferecido ou ' +
  'combinado. Responda SOMENTE com um JSON no formato ' +
  '{"notes": [{"headline": string, "body": string}]} — headline é uma linha curta para o índice; ' +
  'body é o detalhe. Sem fatos duráveis? Responda {"notes": []}. Nada fora do JSON.';

/** Instrução FIXA da compaction — marcador estável para os testes. */
export const COMPACTION_INSTRUCTION =
  'Compacte a conversa acima num resumo estruturado que PRESERVE explicitamente: compromissos ' +
  'assumidos, objeções do lead, dados pessoais citados e o estágio do funil. Responda SOMENTE com ' +
  'um JSON no formato {"commitments": string[], "objections": string[], "personal_data": string[], ' +
  '"stage": string|null, "rolling_summary": string} — rolling_summary acumula o fio da conversa ' +
  '(inclua o que o resumo anterior já dizia). Sem texto fora do JSON.';

export const compactionOutputSchema = z.object({
  commitments: z.array(z.string()).default([]),
  objections: z.array(z.string()).default([]),
  personal_data: z.array(z.string()).default([]),
  stage: z.string().nullable().default(null),
  rolling_summary: z.string().default(''),
});
export type CompactionOutput = z.infer<typeof compactionOutputSchema>;

const flushOutputSchema = z.object({
  notes: z
    .array(z.object({ headline: z.string().min(1), body: z.string().min(1) }))
    .default([]),
});

/** Extrai o JSON do texto do modelo (tolerante a cerca de código/prosa) SEM ecoar o texto (PII). */
function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error('resposta do modelo auxiliar sem JSON');
  }
  return JSON.parse(text.slice(start, end + 1));
}

/**
 * Renderização determinística do resumo compactado que entra no prompt (SUFIXO por-lead).
 * Todos os campos estruturados são planificados no texto — é o que a regra de cache exige
 * (nunca o transcript integral) e o que carrega compromissos/objeções/estágio ao próximo turno.
 */
export function renderCompactedSummary(c: CompactionOutput): string {
  const parts: string[] = [];
  const summary = c.rolling_summary.trim();
  if (summary) parts.push(summary);
  if (c.stage) parts.push(`Estágio do funil: ${c.stage}.`);
  if (c.commitments.length > 0) parts.push(`Compromissos: ${c.commitments.join('; ')}.`);
  if (c.objections.length > 0) parts.push(`Objeções do lead: ${c.objections.join('; ')}.`);
  if (c.personal_data.length > 0) parts.push(`Dados pessoais citados: ${c.personal_data.join('; ')}.`);
  return parts.length > 0 ? parts.join('\n') : '—';
}

/**
 * Encaixa o transcript no orçamento de tokens dropando as mensagens mais ANTIGAS
 * (a cauda recente é a que importa; o que sai foi absorvido pelo resumo compactado).
 * Função pura e determinística — o custo é medido pela mesma heurística chars/3,5 do resto.
 */
export function trimTranscriptToBudget(messages: LeadContextMessage[], maxTokens: number): LeadContextMessage[] {
  let tail = messages;
  while (tail.length > 0 && countPayloadTokens(JSON.stringify(tail)) > maxTokens) {
    tail = tail.slice(1);
  }
  return tail;
}

function buildTranscriptMessage(context: LeadContext, previousSummary: string, instruction: string): string {
  return [
    '## Resumo acumulado até aqui',
    previousSummary.trim() || '—',
    '',
    '## Conversa a processar (transcript)',
    JSON.stringify(context),
    '',
    instruction,
  ].join('\n');
}

/**
 * Flush pré-compaction: turno interno que extrai fatos duráveis e os persiste em
 * lead_notes ANTES da compaction. Best-effort: parse inválido ou cap do índice (F3-05)
 * viram log LOUD e seguem — o flush nunca derruba o turno. Grava as notas em SÉRIE
 * antes de a compaction rodar (ordem observável — acceptance 2).
 */
async function runFlush(
  db: pg.Pool,
  cfg: LlmEdgeConfig,
  ids: { tenantId: string; leadId: string; jobId?: string },
  args: { context: LeadContext; previousSummary: string; model?: string; notesIndexMaxTokens: number },
  deps: { registry?: ProviderRegistry; log: Logger },
): Promise<void> {
  const call = await runModelCall(
    db,
    cfg,
    {
      tenantId: ids.tenantId,
      leadId: ids.leadId,
      ...(ids.jobId !== undefined ? { jobId: ids.jobId } : {}),
      purpose: 'flush',
      ...(args.model !== undefined ? { model: args.model } : {}),
      messages: [{ role: 'user', content: buildTranscriptMessage(args.context, args.previousSummary, FLUSH_INSTRUCTION) }],
    },
    { registry: deps.registry, log: deps.log },
  );

  let notes: z.infer<typeof flushOutputSchema>['notes'];
  try {
    notes = flushOutputSchema.parse(extractJson(call.result.text)).notes;
  } catch {
    // Aux batch malformado NÃO é incidente do turno: loga sem PII e segue (a compaction
    // ainda roda; a memória durável simplesmente não ganha notas neste turno).
    deps.log.warn('flush pré-compaction: saída do modelo auxiliar sem JSON de notas — nenhuma nota gravada');
    return;
  }

  for (const note of notes) {
    const res = await applySaveLeadNote(db, ids, { budgetTokens: args.notesIndexMaxTokens }, note);
    if (!res.ok) {
      // ponytail: hard cap do índice (F3-05) no flush automático — loga LOUD e segue
      // (best-effort). Se saturar recorrentemente, subir COMPACTION para consolidar via
      // supersedes num flush dedicado é o próximo degrau. Sem PII: só o código.
      deps.log.warn('flush pré-compaction: nota durável recusada pelo cap do índice de notas', {
        code: res.error.code,
      });
    }
  }
}

/**
 * Compacta o histórico do lead quando ele cresce além do limiar. Retorna null (no-op)
 * quando o gatilho não bate — o turno segue com o transcript cru (capado por
 * get_lead_context). Quando dispara: roda o FLUSH (grava notas duráveis) e SÓ ENTÃO a
 * compaction (resumo estruturado com o modelo barato). Parse inválido da compaction →
 * log LOUD + null (degradação graciosa; o turno não quebra por um aux batch ruim).
 */
export async function maybeCompact(
  db: pg.Pool,
  cfg: LlmEdgeConfig,
  ids: { tenantId: string; leadId: string; jobId?: string },
  args: { context: LeadContext; previousSummary: string; knobs: CompactionKnobs; notesIndexMaxTokens: number },
  deps: { registry?: ProviderRegistry; log: Logger },
): Promise<CompactionOutput | null> {
  if (args.context.messages.length < args.knobs.triggerMessages) {
    return null;
  }

  // Flush ANTES da compaction (acceptance 2): a memória durável é gravada enquanto o
  // contexto ainda está inteiro, antes de a compaction o substituir pelo resumo.
  await runFlush(
    db,
    cfg,
    ids,
    {
      context: args.context,
      previousSummary: args.previousSummary,
      ...(args.knobs.model !== undefined ? { model: args.knobs.model } : {}),
      notesIndexMaxTokens: args.notesIndexMaxTokens,
    },
    deps,
  );

  const call = await runModelCall(
    db,
    cfg,
    {
      tenantId: ids.tenantId,
      leadId: ids.leadId,
      ...(ids.jobId !== undefined ? { jobId: ids.jobId } : {}),
      purpose: 'compaction',
      ...(args.knobs.model !== undefined ? { model: args.knobs.model } : {}),
      messages: [
        { role: 'user', content: buildTranscriptMessage(args.context, args.previousSummary, COMPACTION_INSTRUCTION) },
      ],
    },
    { registry: deps.registry, log: deps.log },
  );

  try {
    return compactionOutputSchema.parse(extractJson(call.result.text));
  } catch {
    deps.log.warn('compaction: saída do modelo auxiliar sem JSON estruturado — turno segue com transcript cru');
    return null;
  }
}
