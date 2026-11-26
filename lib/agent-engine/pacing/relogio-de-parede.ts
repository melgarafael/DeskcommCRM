/**
 * RELÓGIO DE PAREDE NA TZ DO TENANT — Intl puro, sem dependência nova.
 *
 * Mora num módulo próprio porque há DUAS réguas de horário que precisam da
 * MESMA conversão de fuso: a janela do NÚMERO (`engine.ts`, dias e horas de
 * disparo da conexão) e a janela da CAMPANHA de prospecção
 * (`lib/prospecting/janela-da-campanha.ts`, #4830). Duas cópias da conversão
 * seriam duas respostas diferentes para "que horas são aí" — e a segunda
 * cópia é justamente onde a tela promete uma janela e o motor aplica outra.
 */

export interface Wall {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
  weekday: string; // 'Sun'..'Sat'
}

export function wallClock(instant: Date, timezone: string): Wall {
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
export function instantFromWall(y: number, mo: number, d: number, h: number, timezone: string): Date {
  const targetAsUtc = Date.UTC(y, mo - 1, d, h);
  let guess = targetAsUtc;
  for (let i = 0; i < 2; i += 1) {
    const w = wallClock(new Date(guess), timezone);
    const guessAsUtc = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
    guess += targetAsUtc - guessAsUtc;
  }
  return new Date(guess);
}
