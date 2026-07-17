/**
 * Defaults CONSERVADORES do motor anti-ban (F2-11) — a FONTE ÚNICA dos números
 * de pacing do daemon (blueprint 5.2: números anti-ban são fonte única e
 * inconsistente → knobs, nunca constantes). `scripts/lint-pacing.ts` reprova
 * literal de pacing em qualquer outro arquivo de daemon/src.
 *
 * Override por número/sessão: linha em `channel_knobs` (0010) — coluna NULL cai
 * aqui. O CAP DIÁRIO ABSOLUTO não mora aqui nem em channel_knobs: a fonte única
 * é `channel_sessions.daily_message_limit` do CRM (regra dura nº 3), injetado
 * pelo chamador em `decidePacing` (`crmDailyLimit`) — a leitura ao vivo é da
 * cadeia de envio (F2-13/F2-05).
 */

/** Degrau de warm-up: a partir de `minAgeDays` de idade do número vale `cap` envios/dia; `cap: null` = formado (sem cap de warm-up — resta só o limite do CRM). */
export interface WarmupStep {
  minAgeDays: number;
  cap: number | null;
}

export interface PacingKnobs {
  /** Intervalo mínimo entre envios do MESMO número (ms). */
  throttleMs: number;
  /** Teto do jitter randômico somado ao throttle e ao next_allowed_at (ms) — intervalo fixo é assinatura de bot. */
  jitterMaxMs: number;
  /** Janela horária de envio [start, end) na hora local do tenant. */
  windowStartHour: number;
  windowEndHour: number;
  /** Domingo é evitado por default. */
  allowSunday: boolean;
  /** IANA timezone do tenant — a janela é avaliada NELA. */
  timezone: string;
  /** Degraus de warm-up ordenados por minAgeDays crescente (o primeiro cobre idade 0). */
  warmupDailyCaps: WarmupStep[];
}

/**
 * Limites de SANIDADE da edição de knobs no Console (FU-14) — validação de entrada do
 * operador, não defaults de comportamento. Moram aqui porque a doutrina proíbe número de
 * pacing fora deste módulo (scripts/lint-pacing.ts); o Console os importa em vez de
 * cravar literais.
 */
export const KNOB_BOUNDS = {
  /** teto de intervalo/jitter aceito na UI (ms). */
  intervalMaxMs: 600_000,
  /** maior hora aceita como INÍCIO de janela (fim vai até 24). */
  hourLastStart: 23,
  /** fim de janela é exclusivo e pode chegar à meia-noite seguinte. */
  hourEnd: 24,
} as const;

export const PACING_DEFAULTS: PacingKnobs = {
  throttleMs: 1200, // 1 msg / 1,2s
  jitterMaxMs: 800,
  windowStartHour: 7, // janela 7h-22h
  windowEndHour: 22,
  allowSunday: false,
  timezone: 'America/Sao_Paulo',
  // Número sem linha em channel_knobs é tratado como idade 0 (o degrau mais
  // conservador) até alguém registrar number_activated_at.
  warmupDailyCaps: [
    { minAgeDays: 0, cap: 20 },
    { minAgeDays: 4, cap: 50 },
    { minAgeDays: 8, cap: 100 },
    { minAgeDays: 15, cap: 200 },
    { minAgeDays: 31, cap: null },
  ],
};
