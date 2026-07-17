/**
 * Estado durável do pacing (F2-11) — Postgres do harness, sobrevive a restart:
 * knobs por número/sessão (`channel_knobs`, 0010; coluna NULL = default de
 * defaults.ts) e ledger de envios (`pacing_ledger`) de onde saem lastSentAt e
 * sentToday (contado desde a meia-noite LOCAL do tenant). Quem grava no ledger
 * é a cadeia de envio (F2-13) via `recordSend` — este módulo é o seam.
 */
import type { Logger } from '../obs/logger';
import type { Queryable } from '../queue/queue';
import { PACING_DEFAULTS, type PacingKnobs, type WarmupStep } from './defaults';
import { dayStartInTz, type PacingState } from './engine';

interface ChannelKnobsRow {
  throttle_ms: number | null;
  jitter_max_ms: number | null;
  window_start_hour: number | null;
  window_end_hour: number | null;
  allow_sunday: boolean | null;
  timezone: string | null;
  warmup_daily_caps: unknown; // jsonb — shape validado em parseWarmupCaps (nunca confiado)
  number_activated_at: Date;
}

/**
 * Valida o shape do jsonb de degraus (defesa em profundidade com o CHECK da 0010:
 * cobre linha legada/escritor externo e shape errado dentro de um array válido).
 * Inválido → null: o load cai nos DEFAULTS conservadores — falha fechado sem
 * exceção no caminho de envio. Array VAZIO conta como inválido: zero degraus =
 * warm-up desligado, um fail-open silencioso; opt-out legítimo tem forma expressa
 * `[{"minAgeDays":0,"cap":null}]` (1 degrau formado), nunca `[]`.
 */
export function parseWarmupCaps(value: unknown): WarmupStep[] | null {
  if (!Array.isArray(value)) return null;
  const steps: WarmupStep[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return null;
    const { minAgeDays, cap } = item as Record<string, unknown>;
    if (typeof minAgeDays !== 'number' || !Number.isFinite(minAgeDays)) return null;
    if (cap !== null && (typeof cap !== 'number' || !Number.isFinite(cap))) return null;
    steps.push({ minAgeDays, cap });
  }
  return steps.length > 0 ? steps : null;
}

export interface ChannelPacingConfig {
  knobs: PacingKnobs;
  /** null = sem linha em channel_knobs → o engine trata como idade 0 (conservador). */
  numberActivatedAt: Date | null;
}

/**
 * Knobs efetivos do número: linha de channel_knobs (se houver) sobre os defaults.
 * `logger` (o estruturado de obs/) registra knob inválido descartado — a cadeia
 * de envio (F2-13) passa o logger do daemon.
 */
export async function loadChannelKnobs(
  db: Queryable,
  tenantId: string,
  channelSessionId: string,
  logger?: Logger,
): Promise<ChannelPacingConfig> {
  const { rows } = await db.query<ChannelKnobsRow>(
    `select throttle_ms, jitter_max_ms, window_start_hour, window_end_hour,
            allow_sunday, timezone, warmup_daily_caps, number_activated_at
     from channel_knobs
     where tenant_id = $1 and channel_session_id = $2`,
    [tenantId, channelSessionId],
  );
  const row = rows[0];
  if (!row) {
    return { knobs: { ...PACING_DEFAULTS }, numberActivatedAt: null };
  }
  let warmupDailyCaps = PACING_DEFAULTS.warmupDailyCaps;
  if (row.warmup_daily_caps !== null) {
    const parsed = parseWarmupCaps(row.warmup_daily_caps);
    if (parsed) {
      warmupDailyCaps = parsed;
    } else {
      // Falha FECHADO sem derrubar o worker: knob inválido é descartado em favor
      // dos defaults conservadores; o alerta é log (ids não são PII).
      logger?.warn('warmup_daily_caps inválido em channel_knobs — usando defaults conservadores', {
        tenantId,
        channelSessionId,
      });
    }
  }
  return {
    knobs: {
      throttleMs: row.throttle_ms ?? PACING_DEFAULTS.throttleMs,
      jitterMaxMs: row.jitter_max_ms ?? PACING_DEFAULTS.jitterMaxMs,
      windowStartHour: row.window_start_hour ?? PACING_DEFAULTS.windowStartHour,
      windowEndHour: row.window_end_hour ?? PACING_DEFAULTS.windowEndHour,
      allowSunday: row.allow_sunday ?? PACING_DEFAULTS.allowSunday,
      timezone: row.timezone ?? PACING_DEFAULTS.timezone,
      warmupDailyCaps,
    },
    numberActivatedAt: row.number_activated_at,
  };
}

/** lastSentAt (qualquer dia) + sentToday (desde a meia-noite local do tenant). */
export async function loadPacingState(
  db: Queryable,
  tenantId: string,
  channelSessionId: string,
  input: { now: Date; timezone: string; numberActivatedAt: Date | null },
): Promise<PacingState> {
  const dayStart = dayStartInTz(input.now, input.timezone);
  const { rows } = await db.query<{ last_sent_at: Date | null; sent_today: string }>(
    `select max(sent_at) as last_sent_at,
            count(*) filter (where sent_at >= $3) as sent_today
     from pacing_ledger
     where tenant_id = $1 and channel_session_id = $2`,
    [tenantId, channelSessionId, dayStart],
  );
  const row = rows[0];
  return {
    lastSentAt: row?.last_sent_at ?? null,
    sentToday: Number(row?.sent_today ?? 0),
    numberActivatedAt: input.numberActivatedAt,
  };
}

/** Registra um envio efetivado — chamado pela cadeia de envio (F2-13) após o accept do CRM. */
export async function recordSend(
  db: Queryable,
  tenantId: string,
  channelSessionId: string,
  sentAt: Date = new Date(),
): Promise<void> {
  await db.query(
    `insert into pacing_ledger (tenant_id, channel_session_id, sent_at)
     values ($1, $2, $3)`,
    [tenantId, channelSessionId, sentAt],
  );
}
