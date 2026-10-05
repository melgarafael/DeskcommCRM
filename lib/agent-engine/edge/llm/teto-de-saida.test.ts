import { describe, expect, it } from "vitest";

import { TETO_DE_SAIDA_PADRAO, tetoDeSaida } from "./run-model-call";

describe("tetoDeSaida", () => {
  it("sem teto da organização nem da chamada, usa o padrão em vez de pedir o máximo do modelo", () => {
    expect(tetoDeSaida(undefined, undefined)).toBe(TETO_DE_SAIDA_PADRAO);
  });

  it("o teto da organização vence o padrão, para mais ou para menos", () => {
    expect(tetoDeSaida(16000, undefined)).toBe(16000);
    expect(tetoDeSaida(1000, undefined)).toBe(1000);
  });

  it("a chamada só aperta, nunca alarga", () => {
    expect(tetoDeSaida(undefined, 256)).toBe(256);
    expect(tetoDeSaida(undefined, 9000)).toBe(TETO_DE_SAIDA_PADRAO);
    expect(tetoDeSaida(16000, 9000)).toBe(9000);
  });
});
