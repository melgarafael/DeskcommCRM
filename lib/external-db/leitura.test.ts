import { describe, expect, it } from "vitest";

import { LIMITE_MAX, LeituraInvalidaError, montarConsulta, quotarIdentificador } from "./leitura";
import type { PedidoDeLeitura } from "./types";

const COLS = new Set(["id", "nome", "criado_em", "valor"]);

function pedido(over: Partial<PedidoDeLeitura> = {}): PedidoDeLeitura {
  return {
    schema: "public",
    tabela: "pedidos",
    colunas: [],
    filtros: [],
    limite: 50,
    offset: 0,
    ...over,
  };
}

describe("quotarIdentificador", () => {
  it("escapa aspas duplas", () => {
    expect(quotarIdentificador('a"b')).toBe('"a""b"');
  });
});

describe("montarConsulta", () => {
  it("monta select básico com colunas, filtro, ordem e paginação", () => {
    const r = montarConsulta(
      pedido({
        colunas: ["id", "nome"],
        filtros: [{ coluna: "id", operador: "eq", valor: 42 }],
        ordem: { coluna: "nome", desc: true },
        limite: 10,
        offset: 20,
      }),
      COLS,
    );
    expect(r.text).toBe(
      'select "id", "nome" from "public"."pedidos" where "id" = $1 order by "nome" desc limit 10 offset 20',
    );
    expect(r.values).toEqual([42]);
  });

  it("sem colunas vira `*`", () => {
    const r = montarConsulta(pedido(), COLS);
    expect(r.text).toContain('select * from "public"."pedidos"');
  });

  it("recusa coluna que não existe no catálogo (injeção por identificador)", () => {
    expect(() =>
      montarConsulta(pedido({ colunas: ['nome"; drop table x; --'] }), COLS),
    ).toThrow(LeituraInvalidaError);
    expect(() =>
      montarConsulta(pedido({ filtros: [{ coluna: "senha", operador: "eq", valor: "x" }] }), COLS),
    ).toThrow(LeituraInvalidaError);
  });

  it("silencia o nome da tabela mesmo com caractere estranho (caller valida existência)", () => {
    const r = montarConsulta(pedido({ tabela: 'ped idos"; --' }), COLS);
    expect(r.text).toContain('from "public"."ped idos""; --"');
  });

  it("parametriza os valores na ordem das colunas", () => {
    const r = montarConsulta(
      pedido({
        filtros: [
          { coluna: "nome", operador: "contem", valor: "ana" },
          { coluna: "valor", operador: "gte", valor: 100 },
        ],
      }),
      COLS,
    );
    expect(r.text).toContain(`"nome"`);
    expect(r.text).toContain(`"valor" >= $2`);
    expect(r.values).toEqual(["%ana%", 100]);
  });

  it("escapa curingas do LIKE no `contem`", () => {
    const r = montarConsulta(
      pedido({ filtros: [{ coluna: "nome", operador: "contem", valor: "50%_a" }] }),
      COLS,
    );
    expect(r.values).toEqual(["%50\\%\\_a%"]);
    expect(r.text).toContain("escape '\\'");
  });

  it("`in` com lista vazia vira false; com itens vira placeholders", () => {
    expect(montarConsulta(pedido({ filtros: [{ coluna: "id", operador: "in", valor: [] }] }), COLS).text).toContain(
      "where false",
    );
    const r = montarConsulta(
      pedido({ filtros: [{ coluna: "id", operador: "in", valor: [1, 2, 3] }] }),
      COLS,
    );
    expect(r.text).toContain('"id" in ($1, $2, $3)');
    expect(r.values).toEqual([1, 2, 3]);
  });

  it("`in` sem array é erro", () => {
    expect(() =>
      montarConsulta(pedido({ filtros: [{ coluna: "id", operador: "in", valor: "1,2" }] }), COLS),
    ).toThrow(LeituraInvalidaError);
  });

  it("nulo/nao_nulo não consomem parâmetro", () => {
    const r = montarConsulta(
      pedido({
        filtros: [
          { coluna: "nome", operador: "nulo" },
          { coluna: "valor", operador: "nao_nulo" },
        ],
      }),
      COLS,
    );
    expect(r.text).toContain('"nome" is null');
    expect(r.text).toContain('"valor" is not null');
    expect(r.values).toEqual([]);
  });

  it("`eq` com null vira is null", () => {
    const r = montarConsulta(pedido({ filtros: [{ coluna: "nome", operador: "eq", valor: null }] }), COLS);
    expect(r.text).toContain('"nome" is null');
  });

  it("engessa o limite no teto e cai no padrão quando inválido", () => {
    expect(montarConsulta(pedido({ limite: 999999 }), COLS).limite).toBe(LIMITE_MAX);
    expect(montarConsulta(pedido({ limite: 0 }), COLS).limite).toBe(50);
    expect(montarConsulta(pedido({ limite: Number.NaN }), COLS).limite).toBe(50);
    expect(montarConsulta(pedido({ offset: -5 }), COLS).offset).toBe(0);
  });

  it("recusa tabela sem nome", () => {
    expect(() => montarConsulta(pedido({ tabela: "" }), COLS)).toThrow(LeituraInvalidaError);
  });
});
