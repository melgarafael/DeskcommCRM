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

import { fimDaRecorrencia } from "@/lib/financeiro/recorrencia-do-negocio";

import { competenciaDoMes, dentroDoPrazo } from "./route";

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

describe("dentroDoPrazo — o molde para no último mês do contrato (#3602, doc 312)", () => {
  it("sem ends_on, todo mês nasce (molde digitado à mão)", () => {
    expect(dentroDoPrazo("2099-12-05", null)).toBe(true);
  });

  it("contrato de 12 meses ganho em novembro gera 12 competências e para", () => {
    const fim = fimDaRecorrencia(12, 31, new Date("2026-11-20T12:00:00Z"));
    expect(fim).toBe("2027-10-31");

    const geradas: string[] = [];
    for (let i = 0; i < 24; i += 1) {
      const ano = 2026 + Math.floor((10 + i) / 12);
      const mes = ((10 + i) % 12) + 1;
      const competencia = competenciaDoMes(ano, mes, 31);
      if (dentroDoPrazo(competencia, fim)) geradas.push(competencia);
    }
    expect(geradas).toHaveLength(12);
    expect(geradas[0]).toBe("2026-11-30");
    expect(geradas.at(-1)).toBe("2027-10-31");
  });
});
