import { describe, expect, it } from "vitest";

import { diasDeTesteRestantes, fraseDaFaixa } from "./faixa";

/**
 * A faixa de teste grátis (spec da cobrança §9) aparece nos últimos 7 dias do
 * teste. Teste já acabado não mostra faixa: quem trata o vencido é a régua da
 * PR 3a, com aviso e suspensão.
 */
const AGORA = new Date("2026-10-01T12:00:00Z");
const em = (horas: number) => new Date(AGORA.getTime() + horas * 3_600_000).toISOString();

describe("diasDeTesteRestantes", () => {
  it.each([
    ["sem assinatura (isenta)", null],
    ["fora do teste", { estado: "ativa", trial_ate: em(48) }],
    ["teste sem data", { estado: "trial", trial_ate: null }],
    ["teste já acabado", { estado: "trial", trial_ate: em(-1) }],
    ["mais de 7 dias", { estado: "trial", trial_ate: em(7 * 24 + 1) }],
  ])("%s → sem faixa", (_caso, assinatura) => {
    expect(diasDeTesteRestantes(assinatura, AGORA)).toBeNull();
  });

  it.each([
    [2, 1],
    [24, 1],
    [25, 2],
    [5 * 24, 5],
    [7 * 24, 7],
  ])("%i horas restantes → %i dia(s)", (horas, dias) => {
    expect(diasDeTesteRestantes({ estado: "trial", trial_ate: em(horas) }, AGORA)).toBe(dias);
  });
});

describe("fraseDaFaixa", () => {
  it("1 dia não vira '1 dias' nem 'dia(s)': é 'nas próximas 24 horas' (ceil: pode ser daqui a 2 horas)", () => {
    expect(fraseDaFaixa(1)).toBe("Seu teste grátis termina nas próximas 24 horas.");
    expect(fraseDaFaixa(5).replace("{n}", "5")).toBe("Seu teste grátis termina em 5 dias.");
  });
});
