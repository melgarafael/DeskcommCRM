/**
 * Épico Operação Visível (F2ii) — leitura/escrita dos knobs de pacing que o
 * engine JÁ respeita (channel_knobs, coluna NULL = default conservador) + o teto
 * diário absoluto (channel_sessions.daily_message_limit, fonte única — regra
 * dura nº 3). Validação de entrada do operador usa KNOB_BOUNDS de
 * lib/agent-engine/pacing/defaults.ts — números de pacing nunca nascem aqui.
 */
import { z } from "zod";

import {
  KNOB_BOUNDS,
  PACING_DEFAULTS,
  type PacingKnobs,
} from "@/lib/agent-engine/pacing/defaults";
import { parseWarmupCaps } from "@/lib/agent-engine/pacing/store";

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Sanidade de UI para o teto diário (coluna do CRM, não knob do engine — o
 * engine só LÊ channel_sessions.daily_message_limit). 0 é rejeitado: "desligar
 * envios" tem forma expressa (pausar o agente), nunca um teto silencioso de 0.
 */
export const DAILY_LIMIT_BOUNDS = { min: 1, max: 10_000 } as const;

/** Campos editáveis pela tela — null = voltar ao default conservador do engine. */
export const pacingKnobsUpdateSchema = z
  .object({
    channel_session_id: z.string().uuid(),
    throttle_ms: z.number().int().min(0).max(KNOB_BOUNDS.intervalMaxMs).nullable().optional(),
    jitter_max_ms: z.number().int().min(0).max(KNOB_BOUNDS.intervalMaxMs).nullable().optional(),
    window_start_hour: z.number().int().min(0).max(KNOB_BOUNDS.hourLastStart).nullable().optional(),
    window_end_hour: z.number().int().min(1).max(KNOB_BOUNDS.hourEnd).nullable().optional(),
    allow_sunday: z.boolean().nullable().optional(),
    timezone: z
      .string()
      .refine(isValidTimezone, "timezone IANA inválida (ex.: America/Sao_Paulo)")
      .nullable()
      .optional(),
    daily_message_limit: z
      .number()
      .int()
      .min(DAILY_LIMIT_BOUNDS.min)
      .max(DAILY_LIMIT_BOUNDS.max)
      .optional(),
  })
  .strict();

export type PacingKnobsUpdate = z.infer<typeof pacingKnobsUpdateSchema>;

export interface ChannelKnobsRow {
  throttle_ms: number | null;
  jitter_max_ms: number | null;
  window_start_hour: number | null;
  window_end_hour: number | null;
  allow_sunday: boolean | null;
  timezone: string | null;
  warmup_daily_caps: unknown;
  /** idade do número p/ warm-up (linha ausente = engine trata como idade 0). */
  number_activated_at?: string | null;
}

/**
 * Janela efetiva coerente: [start, end) com start < end — a mesma leitura que o
 * engine faz. Valida o PAR RESULTANTE (row nova mesclada com a atual/default),
 * não só os campos enviados: PATCH parcial não pode criar janela invertida.
 */
export function windowIsValid(startHour: number, endHour: number): boolean {
  return startHour < endHour;
}

/** Knobs efetivos para exibição: linha (se houver) sobre os defaults do engine. */
export function effectiveKnobs(row: ChannelKnobsRow | null): PacingKnobs {
  return {
    throttleMs: row?.throttle_ms ?? PACING_DEFAULTS.throttleMs,
    jitterMaxMs: row?.jitter_max_ms ?? PACING_DEFAULTS.jitterMaxMs,
    windowStartHour: row?.window_start_hour ?? PACING_DEFAULTS.windowStartHour,
    windowEndHour: row?.window_end_hour ?? PACING_DEFAULTS.windowEndHour,
    allowSunday: row?.allow_sunday ?? PACING_DEFAULTS.allowSunday,
    timezone: row?.timezone ?? PACING_DEFAULTS.timezone,
    warmupDailyCaps: parseWarmupCaps(row?.warmup_daily_caps) ?? PACING_DEFAULTS.warmupDailyCaps,
  };
}

/** Payload de GET para a tela: efetivo + o que é override + limites de edição. */
export function knobsView(row: ChannelKnobsRow | null) {
  return {
    effective: effectiveKnobs(row),
    overrides: row,
    defaults: PACING_DEFAULTS,
    bounds: { ...KNOB_BOUNDS, daily_limit: DAILY_LIMIT_BOUNDS },
  };
}
