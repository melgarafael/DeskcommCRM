/**
 * Mozambican national holidays 2026-2030.
 * Used by the LGPD SLA calculator to skip non-business days.
 *
 * Most Mozambican public holidays are fixed calendar dates. Sexta-feira
 * Santa (Good Friday) is the one exception — it's moveable, tied to Easter,
 * and computed here via the Anonymous Gregorian (Meeus/Jones/Butcher)
 * algorithm rather than hardcoded, so it stays correct past 2030 without
 * anyone maintaining a lookup table.
 */

const YEARS = [2026, 2027, 2028, 2029, 2030];
const FIXED_DATES = [
  "01-01", // Ano Novo
  "02-03", // Dia dos Heróis Moçambicanos
  "04-07", // Dia da Mulher Moçambicana
  "05-01", // Dia Internacional dos Trabalhadores
  "06-25", // Dia da Independência Nacional
  "09-07", // Dia da Vitória
  "09-25", // Dia das Forças Armadas de Libertação Nacional
  "10-04", // Dia da Paz e Reconciliação
  "12-25", // Natal / Dia da Família
];

/** Easter Sunday (Gregorian), Anonymous/Meeus algorithm — accurate for any year in the Gregorian calendar. */
function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const FIXED_HOLIDAYS: string[] = [];
for (const year of YEARS) {
  for (const md of FIXED_DATES) {
    FIXED_HOLIDAYS.push(`${year}-${md}`);
  }
  const easter = easterSunday(year);
  const sextaFeiraSanta = new Date(easter.getTime() - 2 * 24 * 60 * 60 * 1000);
  FIXED_HOLIDAYS.push(toIsoDate(sextaFeiraSanta));
}

export const HOLIDAYS_MZ_ISO: string[] = FIXED_HOLIDAYS;

const _holidaySet = new Set(HOLIDAYS_MZ_ISO);

/**
 * Returns true if the given date falls on a Mozambican national holiday.
 * Comparison is done in Africa/Maputo timezone.
 */
export function isHolidayMZ(date: Date): boolean {
  const isoDate = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Africa/Maputo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  return _holidaySet.has(isoDate);
}
