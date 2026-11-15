import { describe, expect, it } from "vitest";

import { contemAssuntoComercialNaSaida, trechoComercialNaSaida } from "@/lib/escalacao/assunto-comercial";

describe("trechoComercialNaSaida", () => {
  it.each([
    ["Pode ficar tranquilo, é sem custo nenhum", "custo"],
    ["Sai por R$ 99 no plano", "r$ 99"],
    ["Dá para pagar em 3x no cartão", "pagar"],
    ["Parcelamos em 3x", "parcelamos"],
    ["Tudo grátis no primeiro mês", "gratis"],
  ])("%s → %s", (texto, trecho) => {
    expect(trechoComercialNaSaida(texto)).toBe(trecho);
  });

  it("texto sem assunto comercial → null", () => {
    expect(trechoComercialNaSaida("Bom dia! Conseguiu ver o diagnóstico do seu site?")).toBeNull();
  });

  it("nunca passa de 40 caracteres", () => {
    expect((trechoComercialNaSaida("r$ " + "9".repeat(80)) ?? "").length).toBeLessThanOrEqual(40);
  });

  it("concorda com contemAssuntoComercialNaSaida", () => {
    for (const t of ["sem custo", "oi tudo bem", "valor", "15.10 às 14.30"]) {
      expect(trechoComercialNaSaida(t) !== null).toBe(contemAssuntoComercialNaSaida(t));
    }
  });
});
