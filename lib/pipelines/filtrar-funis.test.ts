import { describe, expect, it } from "vitest";

import { filtrarFunis } from "./filtrar-funis";

const FUNIS = [
  { name: "Prospecção (Site)" },
  { name: "Prospecção (Indicação)" },
  { name: "Obras e Reformas" },
  { name: "Matrículas" },
  { name: "Clientes" },
];

const nomes = (termo: string) => filtrarFunis(FUNIS, termo).map((f) => f.name);

describe("Funis: busca por trecho do nome (#4593)", () => {
  it("acha pelo trecho que separa dois funis de mesmo prefixo", () => {
    expect(nomes("site")).toEqual(["Prospecção (Site)"]);
    expect(nomes("indicacao")).toEqual(["Prospecção (Indicação)"]);
  });

  it("ignora caixa", () => {
    expect(nomes("OBRAS")).toEqual(["Obras e Reformas"]);
  });

  it("ignora acento nos DOIS lados", () => {
    expect(nomes("prospeccao")).toEqual(["Prospecção (Site)", "Prospecção (Indicação)"]);
    expect(nomes("matriculas")).toEqual(["Matrículas"]);
    expect(nomes("PROSPECÇÃO")).toEqual(["Prospecção (Site)", "Prospecção (Indicação)"]);
  });

  it("casa com o termo da comunidade: «prospeccao» acha os dois funis de prospecção", () => {
    // ⚠️ «prospeccao site» (duas palavras, sem o parêntese) NÃO casa por trecho:
    // normalizar o nome dá "prospeccao (site)". Ordem das palavras e pontuação
    // são a fatia 2 da issue, declarada como fora deste PR.
    expect(nomes("prospeccao")).toEqual(["Prospecção (Site)", "Prospecção (Indicação)"]);
    expect(nomes("site")).toEqual(["Prospecção (Site)"]);
  });

  it("termo que não existe devolve lista vazia", () => {
    expect(nomes("funil inexistente")).toEqual([]);
  });
});

describe("Funis: controle negativo, sem termo (#4593)", () => {
  it("lista sem termo volta COMPLETA, na mesma ordem e na mesma referência", () => {
    expect(filtrarFunis(FUNIS, "")).toBe(FUNIS);
    expect(filtrarFunis(FUNIS, "  ")).toBe(FUNIS);
    expect(nomes("")).toEqual(FUNIS.map((f) => f.name));
  });
});
