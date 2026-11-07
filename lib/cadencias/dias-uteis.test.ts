import { describe, expect, it } from "vitest";

import { avancarDiasUteis, eDiaUtilBR } from "./dias-uteis";

describe("avancarDiasUteis", () => {
  it("pula fim de semana", () => {
    // sexta-feira 2026-01-02 14:00 UTC + 1 dia útil = segunda 2026-01-05 14:00
    const sexta = new Date("2026-01-02T14:00:00.000Z");
    const resultado = avancarDiasUteis(sexta, 1);
    expect(resultado.toISOString()).toBe("2026-01-05T14:00:00.000Z");
  });

  it("preserva a hora exata, não vira meia-noite", () => {
    const inicio = new Date("2026-01-05T09:37:12.000Z"); // segunda
    const resultado = avancarDiasUteis(inicio, 2); // ter, qua
    expect(resultado.toISOString()).toBe("2026-01-07T09:37:12.000Z");
  });

  it("pula feriado nacional (1º de janeiro)", () => {
    const dez31 = new Date("2025-12-31T10:00:00.000Z"); // quarta
    // 1 dia útil: pula 1º/jan (feriado) e o fim de semana seguinte é longe —
    // 2026-01-01 é feriado (quinta), então cai em 2026-01-02 (sexta).
    const resultado = avancarDiasUteis(dez31, 1);
    expect(resultado.toISOString()).toBe("2026-01-02T10:00:00.000Z");
  });

  it("zero dias úteis não muda a data", () => {
    const agora = new Date("2026-01-05T12:00:00.000Z");
    expect(avancarDiasUteis(agora, 0).toISOString()).toBe(agora.toISOString());
  });
});

describe("eDiaUtilBR", () => {
  it("sábado e domingo não são dia útil", () => {
    expect(eDiaUtilBR(new Date("2026-01-03T12:00:00.000Z"))).toBe(false); // sábado
    expect(eDiaUtilBR(new Date("2026-01-04T12:00:00.000Z"))).toBe(false); // domingo
  });

  it("dia de semana comum é dia útil", () => {
    expect(eDiaUtilBR(new Date("2026-01-05T12:00:00.000Z"))).toBe(true); // segunda
  });
});
