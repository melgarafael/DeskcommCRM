import { describe, expect, it } from "vitest";

import {
  filtroDaBuscaDoCatalogo,
  intervaloDaPagina,
  paginaDaUrl,
  queryDaTela,
  ultimaPagina,
} from "@/lib/catalogo/busca-da-tela";

/** As condições do `or=`, uma por coluna. */
const condicoes = (f: string | null) => (f ?? "").split(",");

describe("filtroDaBuscaDoCatalogo — o termo digitado, antes de virar filtro", () => {
  it("procura nas quatro colunas que a tela mostra", () => {
    expect(condicoes(filtroDaBuscaDoCatalogo("g17"))).toEqual([
      "nome.ilike.*g17*",
      "codigo.ilike.*g17*",
      "marca.ilike.*g17*",
      "categoria.ilike.*g17*",
    ]);
  });

  it("espaço vira curinga: 'glock 17' acha 'Glock G17'", () => {
    expect(condicoes(filtroDaBuscaDoCatalogo("glock 17"))[0]).toBe("nome.ilike.*glock*17*");
  });

  it("vírgula não injeta condição", () => {
    expect(condicoes(filtroDaBuscaDoCatalogo("pistola,ativo.eq.false"))).toHaveLength(4);
  });

  it("parêntese sem par não derruba o filtro", () => {
    const f = filtroDaBuscaDoCatalogo("(15) 99259");
    expect(f).not.toMatch(/[()]/);
    expect(condicoes(f)[0]).toBe("nome.ilike.*15*99259*");
  });

  it("`%` e `_` digitados são literais, não curingas", () => {
    expect(condicoes(filtroDaBuscaDoCatalogo("50%_off"))[0]).toBe("nome.ilike.*50\\%\\_off*");
  });

  it.each(["", "   ", "a", ", ,", "()", "**"])(
    "termo que não vale consulta (%j) não filtra — e nunca vira `%%`",
    (termo) => {
      expect(filtroDaBuscaDoCatalogo(termo)).toBeNull();
    },
  );
});

describe("paginação pela URL", () => {
  it.each([
    [undefined, 1],
    ["", 1],
    ["0", 1],
    ["-3", 1],
    ["abc", 1],
    ["3", 3],
  ])("pagina=%j vira %d", (bruto, esperado) => {
    expect(paginaDaUrl(bruto)).toBe(esperado);
  });

  it("a página N é a fatia [(N-1)*50, N*50-1]", () => {
    expect(intervaloDaPagina(1)).toEqual([0, 49]);
    expect(intervaloDaPagina(3)).toEqual([100, 149]);
  });
});

describe("voltar a uma página que existe", () => {
  it.each([
    [0, 1],
    [1, 1],
    [50, 1],
    [51, 2],
    [529, 11],
  ])("%d produtos → última página %d", (total, esperado) => {
    expect(ultimaPagina(total)).toBe(esperado);
  });

  it("a query da tela omite busca vazia e página 1", () => {
    expect(queryDaTela("", 1)).toBe("");
    expect(queryDaTela("  g17 ", 1)).toBe("?busca=g17");
    expect(queryDaTela("g17", 3)).toBe("?busca=g17&pagina=3");
    expect(queryDaTela("", 2)).toBe("?pagina=2");
  });
});
