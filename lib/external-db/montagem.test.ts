import { describe, expect, it } from "vitest";

import { LeituraInvalidaError, SINTAXE_MYSQL, SINTAXE_POSTGRES, montarConsultaCom } from "./montagem";
import type { PedidoDeLeitura } from "./types";

const PERMITIDAS = new Set(["id", "nome", "total", "status"]);

function pedido(extra: Partial<PedidoDeLeitura> = {}): PedidoDeLeitura {
  return { schema: "loja", tabela: "pedidos", colunas: [], filtros: [], limite: 50, offset: 0, ...extra };
}

describe("montarConsultaCom — PostgreSQL (a saída não pode mudar)", () => {
  it("quota com aspas duplas e numera os valores com $n", () => {
    const c = montarConsultaCom(
      SINTAXE_POSTGRES,
      pedido({ colunas: ["id", "total"], filtros: [{ coluna: "status", operador: "eq", valor: "pago" }], ordem: { coluna: "id", desc: true } }),
      PERMITIDAS,
    );
    expect(c.text).toBe(
      'select "id", "total" from "loja"."pedidos" where "status" = $1 order by "id" desc limit 50 offset 0',
    );
    expect(c.values).toEqual(["pago"]);
  });

  it("`contem` ignora caixa e espaços, com escape de barra", () => {
    const c = montarConsultaCom(SINTAXE_POSTGRES, pedido({ filtros: [{ coluna: "nome", operador: "contem", valor: "CB 250_%" }] }), PERMITIDAS);
    expect(c.text).toContain(`replace(lower(cast("nome" as text)), ' ', '') like $1 escape '\\'`);
    expect(c.values).toEqual(["%cb250\\_\\%%"]);
  });
});

describe("montarConsultaCom — MySQL", () => {
  it("quota com crase e usa ? para todo valor", () => {
    const c = montarConsultaCom(
      SINTAXE_MYSQL,
      pedido({
        colunas: ["id", "total"],
        filtros: [
          { coluna: "status", operador: "eq", valor: "pago" },
          { coluna: "total", operador: "gte", valor: 10 },
        ],
        ordem: { coluna: "id" },
      }),
      PERMITIDAS,
    );
    expect(c.text).toBe(
      "select `id`, `total` from `loja`.`pedidos` where `status` = ? and `total` >= ? order by `id` asc limit 50 offset 0",
    );
    expect(c.values).toEqual(["pago", 10]);
  });

  it("`contem` e `comeca_com`: cast as char, escape '!' e o próprio ! escapado", () => {
    const contem = montarConsultaCom(SINTAXE_MYSQL, pedido({ filtros: [{ coluna: "nome", operador: "contem", valor: "CB 250_%!" }] }), PERMITIDAS);
    expect(contem.text).toContain("replace(lower(cast(`nome` as char)), ' ', '') like ? escape '!'");
    expect(contem.values).toEqual(["%cb250!_!%!!%"]);
    const comeca = montarConsultaCom(SINTAXE_MYSQL, pedido({ filtros: [{ coluna: "nome", operador: "comeca_com", valor: "Ab" }] }), PERMITIDAS);
    expect(comeca.values).toEqual(["ab%"]);
  });

  it("crase dentro do nome é dobrada: o identificador nunca fecha a crase por conta própria", () => {
    const c = montarConsultaCom(SINTAXE_MYSQL, pedido({ schema: "a`b", tabela: "t`" }), PERMITIDAS);
    expect(c.text).toContain("from `a``b`.`t```");
  });

  it("`in` com lista vira ?, ?, ... e com lista vazia vira false; sem array é recusado", () => {
    const c = montarConsultaCom(SINTAXE_MYSQL, pedido({ filtros: [{ coluna: "status", operador: "in", valor: ["a", "b"] }] }), PERMITIDAS);
    expect(c.text).toContain("`status` in (?, ?)");
    expect(c.values).toEqual(["a", "b"]);
    expect(montarConsultaCom(SINTAXE_MYSQL, pedido({ filtros: [{ coluna: "status", operador: "in", valor: [] }] }), PERMITIDAS).text).toContain("where false");
    expect(() => montarConsultaCom(SINTAXE_MYSQL, pedido({ filtros: [{ coluna: "status", operador: "in", valor: "a" }] }), PERMITIDAS)).toThrow(LeituraInvalidaError);
  });

  it("`eq`/`ne` com null viram is null / is not null (sem valor)", () => {
    const eq = montarConsultaCom(SINTAXE_MYSQL, pedido({ filtros: [{ coluna: "status", operador: "eq", valor: null }] }), PERMITIDAS);
    expect(eq.text).toContain("`status` is null");
    expect(eq.values).toEqual([]);
    const ne = montarConsultaCom(SINTAXE_MYSQL, pedido({ filtros: [{ coluna: "status", operador: "ne", valor: null }] }), PERMITIDAS);
    expect(ne.text).toContain("`status` is not null");
  });

  it("recusa coluna fora das permitidas — na projeção, no filtro e na ordem", () => {
    expect(() => montarConsultaCom(SINTAXE_MYSQL, pedido({ colunas: ["senha"] }), PERMITIDAS)).toThrow(/coluna_inexistente:senha/);
    expect(() => montarConsultaCom(SINTAXE_MYSQL, pedido({ filtros: [{ coluna: "senha", operador: "eq", valor: 1 }] }), PERMITIDAS)).toThrow(/coluna_inexistente/);
    expect(() => montarConsultaCom(SINTAXE_MYSQL, pedido({ ordem: { coluna: "senha" } }), PERMITIDAS)).toThrow(/coluna_inexistente/);
  });

  it("o limite respeita o teto da conexão e o absoluto; limite e offset saem como número, nunca como texto do usuário", () => {
    const c = montarConsultaCom(SINTAXE_MYSQL, pedido({ limite: 5000, offset: 7 }), PERMITIDAS, { limiteMax: 100 });
    expect(c.limite).toBe(100);
    expect(c.text.endsWith("limit 100 offset 7")).toBe(true);
  });
});
