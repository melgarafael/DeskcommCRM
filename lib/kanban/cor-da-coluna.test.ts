import { describe, expect, it } from "vitest";

import { bordaDaColuna, corDaEtapaValida, fundoDaColuna } from "./cor-da-coluna";

describe("cor da etapa na coluna (#4802 item 2, continuação)", () => {
  it("hex de seis dígitos vira fundo pastel pela mistura com o tema, não cor chapada", () => {
    expect(fundoDaColuna("#0091ff")).toEqual({
      backgroundColor: "color-mix(in srgb, #0091ff 18%, var(--color-surface-elevated))",
    });
    expect(bordaDaColuna("#0091ff")).toEqual({
      borderColor: "color-mix(in srgb, #0091ff 36%, var(--color-border))",
    });
  });

  it("etapa sem cor não ganha estilo nenhum (a coluna segue neutra, como hoje)", () => {
    for (const vazio of [null, undefined, ""]) {
      expect(fundoDaColuna(vazio)).toBeUndefined();
      expect(bordaDaColuna(vazio)).toBeUndefined();
    }
  });

  it("só hex de seis dígitos entra no style: texto de fora nunca vira CSS", () => {
    const invalidos = [
      "#fff",
      "0091ff",
      "red",
      "#0091ffaa",
      "#0091ff; background: url(x)",
      "var(--x)",
      "#00 91ff",
    ];
    for (const cor of invalidos) {
      expect(corDaEtapaValida(cor), cor).toBe(false);
      expect(fundoDaColuna(cor), cor).toBeUndefined();
      expect(bordaDaColuna(cor), cor).toBeUndefined();
    }
    expect(corDaEtapaValida("#AB4ABA")).toBe(true);
  });
});
