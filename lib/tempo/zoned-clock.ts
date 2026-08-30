/**
 * Conversão hora-de-parede ↔ instante UTC, com fuso IANA explícito.
 *
 * Generaliza o algoritmo já usado em `lib/agent-engine/pacing/engine.ts`
 * (`wallClock`/`instantFromWall`, privados àquele módulo) — mesma técnica de
 * duas passadas pelo offset, correta sob DST. Extraído aqui porque a Agenda
 * precisa da MESMA garantia (não inventar uma conversão de fuso própria) mas
 * em granularidade de MINUTO, que o pacing não precisava.
 */

export interface WallClockParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  /** 0 = domingo .. 6 = sábado, mesma convenção de `attendant_schedule.day_of_week`. */
  weekday: number;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** A hora de parede de `instant` no fuso `timezone`. */
export function wallClockParts(instant: Date, timezone: string): WallClockParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  }).formatToParts(instant);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")) % 24, // algumas ICU rendem '24' à meia-noite
    minute: Number(get("minute")),
    weekday: WEEKDAY_INDEX[get("weekday")] ?? 0,
  };
}

/**
 * Instante UTC cuja hora de parede em `timezone` é exatamente
 * (year, month, day, hour, minute) — técnica de duas passadas pelo offset,
 * correta inclusive sob DST.
 */
export function instantFromWallClock(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
): Date {
  const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  let guess = targetAsUtc;
  for (let i = 0; i < 2; i += 1) {
    const w = wallClockParts(new Date(guess), timezone);
    const guessAsUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
    guess += targetAsUtc - guessAsUtc;
  }
  return new Date(guess);
}
