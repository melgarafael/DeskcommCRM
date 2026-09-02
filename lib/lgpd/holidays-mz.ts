/**
 * Mozambican national holidays 2026-2030.
 * Used by the LGPD SLA calculator to skip non-business days.
 *
 * All Mozambican public holidays are fixed calendar dates — unlike Brazil,
 * there is no Carnival, Good Friday, or Corpus Christi in the official
 * calendar, so no moveable-holiday list is needed here.
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

const FIXED_HOLIDAYS: string[] = [];
for (const year of YEARS) {
  for (const md of FIXED_DATES) {
    FIXED_HOLIDAYS.push(`${year}-${md}`);
  }
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
