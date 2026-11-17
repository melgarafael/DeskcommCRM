import { describe, expect, it } from "vitest";

import { filtrarEtiquetas } from "./filtrar-etiquetas";

const ETIQUETAS = ["Promoção", "vip", "Objeção de preço", "Cliente novo"];

describe('Funil: "promocao" sugere "Promoção" (#4166)', () => {
  it("sem acento, a etiqueta existente continua sugerida", () => {
    expect(filtrarEtiquetas(ETIQUETAS, "promocao")).toEqual(["Promoção"]);
  });

  it("em maiúsculas sem acento também acha", () => {
    expect(filtrarEtiquetas(ETIQUETAS, "PROMOCAO")).toEqual(["Promoção"]);
  });

  it("com o acento digitado, o resultado é o mesmo", () => {
    expect(filtrarEtiquetas(ETIQUETAS, "promoção")).toEqual(["Promoção"]);
  });

  it("acha etiqueta acentuada no meio da palavra", () => {
    expect(filtrarEtiquetas(ETIQUETAS, "objecao")).toEqual(["Objeção de preço"]);
  });

  it("termo que não existe não sugere nada", () => {
    expect(filtrarEtiquetas(ETIQUETAS, "inverno")).toEqual([]);
  });

  it("termo vazio devolve a lista inteira, na mesma referência", () => {
    expect(filtrarEtiquetas(ETIQUETAS, "")).toBe(ETIQUETAS);
    expect(filtrarEtiquetas(ETIQUETAS, "  ")).toBe(ETIQUETAS);
  });
});
