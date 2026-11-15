import { describe, expect, it } from "vitest";

import { filtrarFluxos } from "./filtrar-fluxos";

/**
 * Os treze de retomada da queixa da comunidade (#4593): nomes parecidos, e o
 * cartão corta o que diferencia um do outro. Buscar por trecho é o que resolve.
 */
const FLUXOS = [
  { name: "Kelly · retomada (oficinas mecânica)" },
  { name: "Kelly · retomada (clínicas)" },
  { name: "Kelly · retomada (salões)" },
  { name: "Orçamento enviado — 3 dias" },
  { name: "Pós-venda 30 dias" },
];

const nomes = (termo: string) => filtrarFluxos(FLUXOS, termo).map((f) => f.name);

describe("Fluxos de follow-up: busca por trecho do nome (#4593)", () => {
  it("acha pelo trecho que diferencia dois fluxos de nome parecido", () => {
    expect(nomes("oficina")).toEqual(["Kelly · retomada (oficinas mecânica)"]);
    expect(nomes("clínicas")).toEqual(["Kelly · retomada (clínicas)"]);
  });

  it("ignora caixa: MAIÚSCULAS acham o mesmo fluxo", () => {
    expect(nomes("OFICINAS")).toEqual(["Kelly · retomada (oficinas mecânica)"]);
  });

  it("ignora acento nos DOIS lados: sem acento acha o acentuado, e vice-versa", () => {
    expect(nomes("clinicas")).toEqual(["Kelly · retomada (clínicas)"]);
    expect(nomes("orçamento")).toEqual(["Orçamento enviado — 3 dias"]);
    expect(nomes("ORCAMENTO")).toEqual(["Orçamento enviado — 3 dias"]);
    expect(nomes("pos-venda")).toEqual(["Pós-venda 30 dias"]);
  });

  it("acha no meio do nome, não só no começo", () => {
    expect(nomes("retomada")).toHaveLength(3);
  });

  it("termo que não existe devolve lista vazia", () => {
    expect(nomes("juridico")).toEqual([]);
  });
});

describe("Fluxos de follow-up: controle negativo, sem termo (#4593)", () => {
  it("lista sem termo volta COMPLETA, na mesma ordem e na mesma referência", () => {
    expect(filtrarFluxos(FLUXOS, "")).toBe(FLUXOS);
    expect(filtrarFluxos(FLUXOS, "   ")).toBe(FLUXOS);
    expect(nomes("")).toEqual(FLUXOS.map((f) => f.name));
  });
});
