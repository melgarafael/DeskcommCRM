/**
 * Feriados nacionais de Portugal 2026-2030.
 * Usados pelo cálculo do prazo do RGPD para saltar dias não úteis.
 *
 * São os feriados obrigatórios do Código do Trabalho (art. 234.º). Quatro deles
 * — Corpo de Deus, 5 de Outubro, 1 de Novembro e 1 de Dezembro — foram
 * suspensos pela Lei n.º 23/2012 a partir de 2013 e repostos pela Lei n.º
 * 8/2016. Aqui moram os dez fixos e os dois móveis que podem cair em dia útil
 * (Sexta-feira Santa e Corpo de Deus); o Domingo de Páscoa também é
 * obrigatório, mas cai sempre a domingo, que o prazo já salta.
 *
 * A Terça-feira de Carnaval NÃO entra: é feriado facultativo (art. 235.º),
 * decidido ano a ano. Listá-la faria o prazo pular um dia útil a mais.
 *
 * Os móveis saem da data da Páscoa e ficam listados à mão para 2026-2030,
 * como faz `holidays-br.ts`.
 */

// Feriados fixos (padrão MM-DD repetido para cada ano 2026-2030)
const FIXED_HOLIDAYS: string[] = [];

const YEARS = [2026, 2027, 2028, 2029, 2030];
const FIXED_DATES = [
  "01-01", // Ano Novo
  "04-25", // Dia da Liberdade (25 de Abril)
  "05-01", // Dia do Trabalhador
  "06-10", // Dia de Portugal, de Camões e das Comunidades Portuguesas
  "08-15", // Assunção de Nossa Senhora
  "10-05", // Implantação da República
  "11-01", // Dia de Todos os Santos
  "12-01", // Restauração da Independência
  "12-08", // Imaculada Conceição
  "12-25", // Natal
];

for (const year of YEARS) {
  for (const md of FIXED_DATES) {
    FIXED_HOLIDAYS.push(`${year}-${md}`);
  }
}

// Feriados móveis 2026-2030 (Páscoa: 05-04/28-03/16-04/01-04/21-04)
const MOVEABLE_HOLIDAYS: string[] = [
  // 2026
  "2026-04-03", // Sexta-feira Santa
  "2026-06-04", // Corpo de Deus
  // 2027
  "2027-03-26", // Sexta-feira Santa
  "2027-05-27", // Corpo de Deus
  // 2028
  "2028-04-14", // Sexta-feira Santa
  "2028-06-15", // Corpo de Deus
  // 2029
  "2029-03-30", // Sexta-feira Santa
  "2029-05-31", // Corpo de Deus
  // 2030
  "2030-04-19", // Sexta-feira Santa
  "2030-06-20", // Corpo de Deus
];

export const HOLIDAYS_PT_ISO: string[] = [...FIXED_HOLIDAYS, ...MOVEABLE_HOLIDAYS];

const _holidaySet = new Set(HOLIDAYS_PT_ISO);

/**
 * Returns true if the given date falls on a Portuguese national holiday.
 * Comparison is done in the Europe/Lisbon timezone.
 */
export function isHolidayPT(date: Date): boolean {
  // Format: YYYY-MM-DD in Lisbon timezone
  const isoDate = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Lisbon",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  return _holidaySet.has(isoDate);
}
