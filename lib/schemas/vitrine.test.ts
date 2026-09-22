import { describe, expect, it } from "vitest";

import { precoDeVitrine } from "./produtos";

describe("precoDeVitrine", () => {
  const base = { preco_cents: 1600, preco_promocional_cents: 1299, promocao_ate: "2026-09-30" };
  it("vale com data futura", () => {
    expect(precoDeVitrine(base, "2026-09-06")).toEqual({ cents: 1299, emPromocao: true });
  });
  it("vale no último dia", () => {
    expect(precoDeVitrine(base, "2026-09-30")).toEqual({ cents: 1299, emPromocao: true });
  });
  it("expirada volta ao base", () => {
    expect(precoDeVitrine(base, "2026-10-01")).toEqual({ cents: 1600, emPromocao: false });
  });
  it("sem data final vale sempre", () => {
    expect(precoDeVitrine({ ...base, promocao_ate: null }, "2027-01-01")).toEqual({
      cents: 1299,
      emPromocao: true,
    });
  });
  it("sem preço promocional nunca é promoção", () => {
    expect(precoDeVitrine({ preco_cents: 1600, preco_promocional_cents: null, promocao_ate: null }, "2026-09-06")).toEqual(
      { cents: 1600, emPromocao: false },
    );
  });
});
