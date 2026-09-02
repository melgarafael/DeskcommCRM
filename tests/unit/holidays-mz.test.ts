import { describe, expect, it } from "vitest";

import { HOLIDAYS_MZ_ISO, isHolidayMZ } from "@/lib/lgpd/holidays-mz";

/**
 * Sexta-feira Santa (Good Friday) é feriado nacional em Moçambique e é
 * MÓVEL (depende da Páscoa) — ao contrário dos outros 9 feriados, que são
 * data fixa. Datas conferidas contra o algoritmo de Meeus/Jones/Butcher
 * (Páscoa Gregoriana), independente da implementação.
 */
describe("feriados moçambicanos — Sexta-feira Santa (móvel)", () => {
  it.each([
    ["2026-04-03", 2026],
    ["2027-03-26", 2027],
    ["2028-04-14", 2028],
    ["2029-03-30", 2029],
    ["2030-04-19", 2030],
  ])("%s é Sexta-feira Santa de %i", (iso) => {
    expect(HOLIDAYS_MZ_ISO).toContain(iso);
    expect(isHolidayMZ(new Date(`${iso}T12:00:00Z`))).toBe(true);
  });

  it("o dia seguinte (Sábado de Aleluia) NÃO é feriado", () => {
    expect(isHolidayMZ(new Date("2026-04-04T12:00:00Z"))).toBe(false);
  });
});

describe("feriados moçambicanos — os 9 fixos continuam presentes", () => {
  it.each([
    "2026-01-01", // Ano Novo
    "2026-02-03", // Dia dos Heróis Moçambicanos
    "2026-04-07", // Dia da Mulher Moçambicana
    "2026-05-01", // Dia Internacional dos Trabalhadores
    "2026-06-25", // Dia da Independência Nacional
    "2026-09-07", // Dia da Vitória
    "2026-09-25", // Dia das Forças Armadas de Libertação Nacional
    "2026-10-04", // Dia da Paz e Reconciliação
    "2026-12-25", // Natal / Dia da Família
  ])("%s é feriado", (iso) => {
    expect(isHolidayMZ(new Date(`${iso}T12:00:00Z`))).toBe(true);
  });
});
