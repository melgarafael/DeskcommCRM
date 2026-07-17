/**
 * Motor de pacing anti-ban (F2-11) — decisão PURA: dado (relógio, knobs, estado
 * de envios do número, limite diário do CRM, rng) devolve {allow, waitMs} ou
 * {veto, nextAllowedAt, reason pt-br instrutivo}. Roda ANTES de chamar o CRM
 * (regra dura nº 3); a integração na cadeia de envio é da F2-13 — aqui não há
 * I/O nenhum. Clock e RNG são injetáveis (testes com clock fake e jitter
 * determinístico); em produção o chamador passa `new Date()` e omite o rng.
 *
 * Ordem de avaliação: janela horária (tz do tenant, domingo evitado) → caps
 * diários (warm-up por idade do número; limite do CRM injetado) → throttle+jitter.
 */
import type { PacingKnobs, WarmupStep } from './defaults';

export interface PacingState {
  /** Último envio deste número (qualquer dia) — base do throttle. */
  lastSentAt: Date | null;
  /** Envios deste número desde a meia-noite LOCAL do tenant. */
  sentToday: number;
  /** Ativação do número (channel_knobs.number_activated_at); null = idade 0 (conservador). */
  numberActivatedAt: Date | null;
}

export interface PacingInput {
  now: Date;
  knobs: PacingKnobs;
  state: PacingState;
  /** channel_sessions.daily_message_limit do CRM (fonte única do cap diário absoluto); null = sem limite conhecido. */
  crmDailyLimit: number | null;
  /** [0,1) — injetável nos testes; default Math.random. */
  rng?: () => number;
}

export type PacingVetoCode = 'outside_window' | 'warmup_cap' | 'daily_cap';

export type PacingDecision =
  | { allow: true; waitMs: number }
  | { allow: false; code: PacingVetoCode; nextAllowedAt: Date; reason: string };

const DAY_MS = 86_400_000;

export function decidePacing(input: PacingInput): PacingDecision {
  const { now, knobs, state, crmDailyLimit } = input;
  const rng = input.rng ?? Math.random;
  const wall = wallClock(now, knobs.timezone);

  if (!insideWindow(wall, knobs)) {
    const nextAllowedAt = addMs(nextWindowOpen(now, knobs), jitterOf(rng, knobs));
    return {
      allow: false,
      code: 'outside_window',
      nextAllowedAt,
      reason:
        `fora da janela de envio (${knobs.windowStartHour}h-${knobs.windowEndHour}h` +
        `${knobs.allowSunday ? '' : ', sem domingo'}, ${knobs.timezone}); ` +
        `agende para ${formatInTz(nextAllowedAt, knobs.timezone)} (abertura da janela + jitter)`,
    };
  }

  // Clamp em >= 0: number_activated_at no futuro (typo do admin / clock skew
  // daemon↔DB) cai no degrau MAIS conservador — warm-up falha FECHADO, nunca
  // vira "número formado" por idade negativa.
  const ageDays = state.numberActivatedAt
    ? Math.max(0, Math.floor((now.getTime() - state.numberActivatedAt.getTime()) / DAY_MS))
    : 0;
  const wCap = warmupCapFor(ageDays, knobs.warmupDailyCaps);
  const effectiveCap = Math.min(wCap ?? Infinity, crmDailyLimit ?? Infinity);
  if (state.sentToday >= effectiveCap) {
    const nextAllowedAt = addMs(nextDayOpen(now, knobs), jitterOf(rng, knobs));
    const isWarmup = wCap !== null && wCap < (crmDailyLimit ?? Infinity);
    return {
      allow: false,
      code: isWarmup ? 'warmup_cap' : 'daily_cap',
      nextAllowedAt,
      reason: isWarmup
        ? `cap de warm-up atingido (${wCap}/dia para número com ${ageDays} dia(s) de idade); ` +
          `agende para ${formatInTz(nextAllowedAt, knobs.timezone)} (próxima abertura + jitter)`
        : `cap diário do número atingido (${effectiveCap}/dia, limite do CRM); ` +
          `agende para ${formatInTz(nextAllowedAt, knobs.timezone)} (próxima abertura + jitter)`,
    };
  }

  let waitMs = 0;
  if (state.lastSentAt) {
    const requiredGapMs = knobs.throttleMs + jitterOf(rng, knobs);
    waitMs = Math.max(0, requiredGapMs - (now.getTime() - state.lastSentAt.getTime()));
  }
  return { allow: true, waitMs };
}

/**
 * Degrau vigente para a idade (degraus ordenados por minAgeDays crescente).
 * Falha FECHADO: idade aquém do primeiro degrau usa o cap do PRIMEIRO degrau
 * (o mais conservador) — configuração com furo nunca vira "sem cap".
 */
function warmupCapFor(ageDays: number, steps: WarmupStep[]): number | null {
  let cap: number | null = steps[0]?.cap ?? null;
  for (const step of steps) {
    if (ageDays >= step.minAgeDays) cap = step.cap;
  }
  return cap;
}

function jitterOf(rng: () => number, knobs: PacingKnobs): number {
  return Math.floor(rng() * (knobs.jitterMaxMs + 1));
}

function addMs(d: Date, ms: number): Date {
  return new Date(d.getTime() + ms);
}

// ---------------------------------------------------------------------------
// Relógio de parede na tz do tenant — Intl puro, sem dependência nova.

interface Wall {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
  weekday: string; // 'Sun'..'Sat'
}

function wallClock(instant: Date, timezone: string): Wall {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
  }).formatToParts(instant);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return {
    y: Number(get('year')),
    mo: Number(get('month')),
    d: Number(get('day')),
    h: Number(get('hour')) % 24, // algumas ICU rendem '24' à meia-noite
    mi: Number(get('minute')),
    s: Number(get('second')),
    weekday: get('weekday'),
  };
}

/**
 * Instante UTC cuja hora de parede na tz é (y, mo, d, h):00 — técnica clássica
 * de duas passadas pelo offset (correta inclusive sob DST).
 */
function instantFromWall(y: number, mo: number, d: number, h: number, timezone: string): Date {
  const targetAsUtc = Date.UTC(y, mo - 1, d, h);
  let guess = targetAsUtc;
  for (let i = 0; i < 2; i += 1) {
    const w = wallClock(new Date(guess), timezone);
    const guessAsUtc = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
    guess += targetAsUtc - guessAsUtc;
  }
  return new Date(guess);
}

/** Meia-noite LOCAL do tenant contendo `instant` — o corte do "hoje" dos caps diários. */
export function dayStartInTz(instant: Date, timezone: string): Date {
  const w = wallClock(instant, timezone);
  return instantFromWall(w.y, w.mo, w.d, 0, timezone);
}

function insideWindow(wall: Wall, knobs: PacingKnobs): boolean {
  if (!knobs.allowSunday && wall.weekday === 'Sun') return false;
  return wall.h >= knobs.windowStartHour && wall.h < knobs.windowEndHour;
}

/** Próxima abertura de janela ESTRITAMENTE depois de `now` (pula domingo se evitado). */
function nextWindowOpen(now: Date, knobs: PacingKnobs): Date {
  const w = wallClock(now, knobs.timezone);
  for (let add = 0; ; add += 1) {
    // Date.UTC normaliza overflow de dia/mês em instantFromWall.
    const candidate = instantFromWall(w.y, w.mo, w.d + add, knobs.windowStartHour, knobs.timezone);
    if (candidate.getTime() <= now.getTime()) continue;
    if (!knobs.allowSunday && wallClock(candidate, knobs.timezone).weekday === 'Sun') continue;
    return candidate;
  }
}

/** Abertura do PRÓXIMO dia permitido (cap diário reseta na meia-noite local). */
function nextDayOpen(now: Date, knobs: PacingKnobs): Date {
  const w = wallClock(now, knobs.timezone);
  for (let add = 1; ; add += 1) {
    const candidate = instantFromWall(w.y, w.mo, w.d + add, knobs.windowStartHour, knobs.timezone);
    if (!knobs.allowSunday && wallClock(candidate, knobs.timezone).weekday === 'Sun') continue;
    return candidate;
  }
}

/** Render local legível para a mensagem de veto (pt-br vê hora do SEU fuso). */
function formatInTz(instant: Date, timezone: string): string {
  // sv-SE rende 'YYYY-MM-DD HH:mm:ss' — ISO-like, sem dependência.
  return `${new Intl.DateTimeFormat('sv-SE', {
    timeZone: timezone,
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(instant)} (${timezone})`;
}
