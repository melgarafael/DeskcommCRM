import { describe, expect, it } from "vitest";

import { cabeNoCredito, type SituacaoDeCredito } from "@/lib/comercial/credito";

/**
 * A REGRA DE CRÉDITO — cerca do ATT.txt Fase 1/2.
 *
 * Sem limite (NULL) nunca barra: ausência de análise é visível, não zero.
 */
describe("cabeNoCredito", () => {
  const semLimite: SituacaoDeCredito = { temLimite: false, limite_cents: null, em_aberto_cents: 999999 };

  it("sem limite definido, qualquer valor passa", () => {
    expect(cabeNoCredito(semLimite, 1000000)).toBe(true);
  });

  it("cabe quando soma fica dentro do teto", () => {
    const s: SituacaoDeCredito = { temLimite: true, limite_cents: 10000, em_aberto_cents: 6000 };
    expect(cabeNoCredito(s, 4000)).toBe(true);
  });

  it("barra quando soma estoura o teto", () => {
    const s: SituacaoDeCredito = { temLimite: true, limite_cents: 10000, em_aberto_cents: 6000 };
    expect(cabeNoCredito(s, 4001)).toBe(false);
  });

  it("no limite exato ainda cabe", () => {
    const s: SituacaoDeCredito = { temLimite: true, limite_cents: 10000, em_aberto_cents: 6000 };
    expect(cabeNoCredito(s, 4000)).toBe(true);
  });
});
