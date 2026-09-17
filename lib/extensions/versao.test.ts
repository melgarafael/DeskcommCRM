import { describe, expect, it } from "vitest";

import { compararVersoes, ehTrocaParaVersaoMenor } from "./versao";

describe("compararVersoes", () => {
  it("compara numericamente cada parte, não como texto", () => {
    expect(compararVersoes("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compararVersoes("1.0.0", "1.1.0")).toBeLessThan(0);
    expect(compararVersoes("2.0.0", "10.0.0")).toBeLessThan(0);
    expect(compararVersoes("1.2.3", "1.2.3")).toBe(0);
    expect(compararVersoes("1.2.10", "1.2.9")).toBeGreaterThan(0);
    // Acima de 2^53, Number iguala as duas partes; a comparação por dígitos não.
    expect(compararVersoes("1.0.9007199254740993", "1.0.9007199254740992")).toBeGreaterThan(0);
  });
});

describe("ehTrocaParaVersaoMenor", () => {
  it("usa o destino concluído e, enquanto prepara ou depois de falhar, a versão pedida", () => {
    expect(ehTrocaParaVersaoMenor({ from_version: "1.1.0", to_version: "1.0.0", version: "1.0.0" })).toBe(true);
    expect(ehTrocaParaVersaoMenor({ from_version: "1.1.0", to_version: null, version: "1.0.0" })).toBe(true);
    expect(ehTrocaParaVersaoMenor({ from_version: "1.0.0", to_version: null, version: "1.1.0" })).toBe(false);
    expect(ehTrocaParaVersaoMenor({ from_version: null, to_version: null, version: "1.0.0" })).toBe(false);
  });
});
