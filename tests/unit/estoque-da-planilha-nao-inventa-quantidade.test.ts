import { describe, expect, it } from "vitest";

import { lerPlanilha } from "@/lib/catalogo/planilha";
import { traduzir } from "@/lib/i18n/dicionario";

function ler(quantidade: string, idioma: "pt-BR" | "es" = "pt-BR") {
  const r = lerPlanilha(`codigo;nome;preco;estoque\nP1;Produto;10;${quantidade}\n`, (texto) =>
    traduzir(texto, idioma),
  );
  if ("erro" in r) throw new Error(r.erro);
  return r;
}

describe("estoque da planilha não inventa uma quantidade", () => {
  it.each([
    "-5",
    "2,5",
    "2.5",
    "1e3",
    "12 unidades",
    "indisponível",
    "1.2.3",
    "1,000.000",
    "2147483648",
    "9".repeat(400),
  ])("recusa %s por linha em vez de gravar outro número", (texto) => {
    const r = ler(texto);
    expect(r.produtos).toEqual([]);
    expect(r.erros).toEqual([
      {
        linha: 2,
        motivo: `quantidade inválida ("${texto}") — use um inteiro de 0 a 2147483647`,
      },
    ]);
  });

  it.each([
    ["", 0],
    ["0", 0],
    [" 12 ", 12],
    ["0012", 12],
    ["1.000", 1000],
    ["1,000", 1000],
    ["1 000", 1000],
    ["1\u00a0000", 1000],
    ["1.000.000", 1000000],
    ["2147483647", 2147483647],
  ])("preserva %s como %i unidades", (texto, quantidade) => {
    const r = ler(texto);
    expect(r.erros).toEqual([]);
    expect(r.produtos[0]).toMatchObject({ quantidade, controla_estoque: true });
  });

  it("recusa a linha ruim sem reservar o código nem impedir a linha corrigida", () => {
    const r = lerPlanilha("codigo;nome;preco;estoque\nP1;Produto;10;-5\nP1;Produto;10;5\n");
    if ("erro" in r) throw new Error(r.erro);
    expect(r.erros).toHaveLength(1);
    expect(r.produtos).toEqual([
      expect.objectContaining({ linha: 3, codigo: "P1", quantidade: 5 }),
    ]);
  });

  it("a recusa chega em espanhol", () => {
    expect(ler("-5", "es").erros[0]?.motivo).toBe(
      'cantidad no válida ("-5") — usa un entero de 0 a 2147483647',
    );
  });
});
