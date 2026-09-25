import { describe, expect, it } from "vitest";

import { recorteDaGrade } from "./recorte-da-grade";

/**
 * As datas do vermelho de 2026-09-24. Montadas em hora LOCAL (como a
 * `ancoraLocalDoDia` monta), para o teste valer em qualquer fuso de máquina.
 */
const dia = (a: number, m: number, d: number, h = 0) => new Date(a, m - 1, d, h);

describe("recorteDaGrade", () => {
  it("visão Mês busca os dias do mês vizinho que ela desenha (30/09 na grade de outubro)", () => {
    // Quinta 24/09 + 7 = âncora em 01/10; o compromisso é na quarta 30/09.
    const { de, ate } = recorteDaGrade("mes", dia(2026, 10, 1, 12));
    expect(de).toEqual(dia(2026, 9, 27)); // domingo da primeira linha
    expect(ate).toEqual(dia(2026, 11, 8)); // seis semanas depois, exclusivo
    const compromisso = dia(2026, 9, 30, 15);
    expect(compromisso >= de && compromisso < ate).toBe(true);
  });

  it("semana vai de domingo a domingo", () => {
    expect(recorteDaGrade("semana", dia(2026, 10, 1, 12))).toEqual({
      de: dia(2026, 9, 27),
      ate: dia(2026, 10, 4),
    });
  });

  it("dia é o próprio dia", () => {
    expect(recorteDaGrade("dia", dia(2026, 10, 1, 12))).toEqual({
      de: dia(2026, 10, 1),
      ate: dia(2026, 10, 2),
    });
  });
});
