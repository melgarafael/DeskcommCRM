/**
 * A competência de um molde recorrente.
 *
 * Onze meses do ano não têm todos os dias, e a regra do dia 31 é a única parte
 * disto que não é óbvia: o que não existe cai no ÚLTIMO dia do mês. Pular
 * deixaria de cobrar o aluguel em fevereiro; empurrar para março mudaria a
 * competência e faria o relatório de fevereiro parecer melhor do que foi.
 *
 * Esperar fevereiro para descobrir isso seria absurdo — daí a função ser pura.
 */
import { describe, expect, it } from "vitest";

import { competenciaDoMes } from "./route";

describe("competenciaDoMes", () => {
  it("o dia existe no mês, e é ele", () => {
    expect(competenciaDoMes(2026, 9, 10)).toBe("2026-09-10");
  });

  it("dia 31 em mês de 30 cai no dia 30", () => {
    expect(competenciaDoMes(2026, 9, 31)).toBe("2026-09-30");
  });

  it("dia 31 em fevereiro comum cai no dia 28", () => {
    expect(competenciaDoMes(2026, 2, 31)).toBe("2026-02-28");
  });

  it("dia 30 em fevereiro BISSEXTO cai no dia 29", () => {
    // 2028 é bissexto. Se a implementação usasse 28 fixo para fevereiro, este
    // caso passaria despercebido e cobraria um dia antes a cada quatro anos.
    expect(competenciaDoMes(2028, 2, 30)).toBe("2028-02-29");
  });

  it("dia 31 em mês de 31 continua sendo 31", () => {
    expect(competenciaDoMes(2026, 1, 31)).toBe("2026-01-31");
    expect(competenciaDoMes(2026, 12, 31)).toBe("2026-12-31");
  });

  it("dia 1 é sempre dia 1", () => {
    expect(competenciaDoMes(2026, 2, 1)).toBe("2026-02-01");
  });

  it("o mês e o dia saem com dois dígitos — é uma data que vai para uma coluna date", () => {
    // Sem o padding, "2026-2-5" não é uma data ISO e o Postgres a recusaria (ou,
    // pior, alguma camada a interpretaria diferente).
    expect(competenciaDoMes(2026, 2, 5)).toBe("2026-02-05");
  });

  it("dezembro não vira janeiro do ano seguinte", () => {
    // O cálculo do último dia usa o dia 0 do mês SEGUINTE, e é exatamente aqui
    // que um off-by-one viraria 2027-01-31.
    expect(competenciaDoMes(2026, 12, 31)).toBe("2026-12-31");
  });
});
