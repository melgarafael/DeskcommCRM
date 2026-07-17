/**
 * Tool schedule_followup (F3-02) — o agente agenda o PRÓPRIO retorno ao lead: o
 * motor da continuidade (dor nº 4 do dono). Valida o que o modelo prometeu e cria
 * um cron_job one-shot (kind 'at') em promised_at via scheduleCronJob (F3-01). No
 * disparo o cron enfileira um followup_turn na fila do lead (lane por lead, F2-03) e
 * se desabilita — one-shot. A re-entrada temporal plena ("passaram N dias, você
 * prometeu X") é a F3-03; aqui a tool só CRIA o agendamento com o snapshot.
 *
 * Disciplina espelhada da update_lead_state (F2-10): whitelist .strict() + guard de
 * prototype pollution ANTES do parse (Zod v4 dropa __proto__ em silêncio — F2-12);
 * campo extra/forjado vira ENSINO pt-br ao modelo, nunca strip silencioso. tenant e
 * lead vêm SEMPRE do runtime (row do job), jamais do payload do modelo. Data no
 * passado / fora da janela aceitável (knobs) → ensino, sem agendar nada.
 */
import { z } from 'zod';
import type pg from 'pg';

import { scheduleCronJob } from '../cron/scheduler';
import { findForbiddenKey, zodIssuesSummary } from './lead-state';

/** Janela aceitável do retorno agendado pelo agente — knobs (env.ts), nunca constantes. */
export interface FollowupWindowKnobs {
  /** antecedência mínima: promised_at antes disso é "muito cedo" (FOLLOWUP_MIN_AHEAD_MS). */
  minAheadMs: number;
  /** horizonte máximo: promised_at além disso é "muito distante" (FOLLOWUP_MAX_AHEAD_MS). */
  maxAheadMs: number;
  /** janela do stagger determinístico herdada do cron (CRON_STAGGER_WINDOW_MS). */
  staggerWindowMs: number;
}

/** Whitelist EXATA do que o modelo promete — .strict() rejeita o resto (mesmo padrão da F2-10). */
export const scheduleFollowupInputSchema = z.strictObject({
  reason: z.string().min(1).max(500),
  promised_at: z.string().min(1).max(64),
  promise: z.string().min(1).max(1_000),
  context_snapshot: z.string().max(4_000).nullable().optional(),
});
export type ScheduleFollowupInput = z.infer<typeof scheduleFollowupInputSchema>;

export type ScheduleFollowupResult =
  | { ok: true; cronJobId: string; promisedAt: Date; message: string }
  | {
      ok: false;
      error: {
        code: 'invalid_payload' | 'promised_at_in_past' | 'promised_at_out_of_window';
        message: string;
      };
    };

const PAYLOAD_TEACHING =
  'Campos aceitos: reason (por que agendar), promised_at (data ISO 8601 do retorno, no futuro), ' +
  'promise (o que você prometeu ao lead), context_snapshot (contexto curto para o run futuro) — ' +
  'nada além. Lead e organização vêm do runtime, nunca do payload da tool.';

function teachInvalidPayload(issues: string): ScheduleFollowupResult {
  return {
    ok: false,
    error: { code: 'invalid_payload', message: `payload inválido em schedule_followup (${issues}). ${PAYLOAD_TEACHING}` },
  };
}

/** Duração humana pt-br para o ensino da janela — só ordem de grandeza, nunca PII. */
function humanizeMs(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(ms / 86_400_000)} dias`;
}

/**
 * Valida o payload prometido e cria o cron_job one-shot. Idempotência/exactly-once do
 * DISPARO é da F3-01 (scheduleCronJob + tickCron); aqui a garantia é só de validação
 * na CRIAÇÃO. Erros de DB (ex.: lead sumiu) sobem — o tool wrapper do run os captura
 * e ensina o modelo a encerrar (padrão F2-09).
 */
export async function applyScheduleFollowup(
  db: pg.Pool,
  cfg: { clock: () => Date; knobs: FollowupWindowKnobs },
  ids: { tenantId: string; leadId: string },
  rawInput: unknown,
): Promise<ScheduleFollowupResult> {
  const forbidden = findForbiddenKey(rawInput);
  if (forbidden !== null) {
    return teachInvalidPayload(`campos não reconhecidos: ${forbidden}`);
  }
  const parsed = scheduleFollowupInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return teachInvalidPayload(zodIssuesSummary(parsed.error));
  }
  const input = parsed.data;

  const atMs = Date.parse(input.promised_at);
  if (Number.isNaN(atMs)) {
    return teachInvalidPayload('promised_at não é uma data ISO 8601 válida (ex.: "2026-07-15T14:00:00Z")');
  }
  const nowMs = cfg.clock().getTime();
  const { minAheadMs, maxAheadMs, staggerWindowMs } = cfg.knobs;
  if (atMs <= nowMs) {
    return {
      ok: false,
      error: {
        code: 'promised_at_in_past',
        message: 'a data prometida (promised_at) já passou; escolha um horário no futuro para o retorno.',
      },
    };
  }
  if (atMs < nowMs + minAheadMs || atMs > nowMs + maxAheadMs) {
    return {
      ok: false,
      error: {
        code: 'promised_at_out_of_window',
        message:
          `horário fora da janela aceitável de follow-up: agende o retorno entre ` +
          `${humanizeMs(minAheadMs)} e ${humanizeMs(maxAheadMs)} a partir de agora.`,
      },
    };
  }

  // payload = o followup_turn do lead com o snapshot da promessa; vira o payload do
  // job enfileirado no disparo (scheduler.ts fireOneDue passa cron.payload adiante).
  const cron = await scheduleCronJob(db, ids.tenantId, {
    leadId: ids.leadId,
    spec: { kind: 'at', at: new Date(atMs) },
    jobKind: 'followup_turn',
    payload: {
      reason: input.reason,
      promise: input.promise,
      promised_at: input.promised_at,
      context_snapshot: input.context_snapshot ?? null,
    },
    staggerWindowMs,
    now: () => nowMs,
  });

  return {
    ok: true,
    cronJobId: cron.id,
    promisedAt: cron.next_run_at,
    message:
      `retorno agendado para ${input.promised_at}. Encerre o turno agora; ` +
      `o sistema fará o follow-up com o lead no horário combinado.`,
  };
}
