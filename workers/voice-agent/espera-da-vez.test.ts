import { describe, expect, it } from "vitest";

import { esperaDaVez } from "./espera-da-vez";

describe("esperaDaVez", () => {
  it("sem variável, mantém o padrão paciente", () => {
    expect(esperaDaVez(undefined)).toBe("low");
    expect(esperaDaVez("")).toBe("low");
    expect(esperaDaVez("   ")).toBe("low");
  });

  it("aceita os quatro valores da Realtime API, sem ligar para caixa e espaço", () => {
    expect(esperaDaVez("auto")).toBe("auto");
    expect(esperaDaVez("medium")).toBe("medium");
    expect(esperaDaVez(" HIGH ")).toBe("high");
    expect(esperaDaVez("low")).toBe("low");
  });

  it("valor desconhecido cai no padrão em vez de ir para a API", () => {
    expect(esperaDaVez("rapido")).toBe("low");
    expect(esperaDaVez("0.5")).toBe("low");
  });
});
