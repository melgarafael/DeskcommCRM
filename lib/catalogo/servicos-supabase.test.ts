import { describe, expect, it } from "vitest";

import { sinaisFixosQueTravamPreco, todosOsDetalhes } from "./servicos-supabase";

/**
 * A PORTA DO NÚCLEO E A LEITURA QUE FALHA FECHADA.
 *
 * O banco é um dublê que responde por coluna filtrada: o que se mede aqui é a
 * lógica de família (variação → principal → sinal fixo) e a recusa de seguir
 * quando a leitura falha, não o PostgREST.
 */
type Linha = Record<string, unknown>;

function db(detalhes: Linha[], erro: { message: string } | null = null) {
  return {
    from: () => {
      const filtros: Array<[string, unknown[]]> = [];
      const q = {
        select: () => q,
        eq: () => q,
        order: () => q,
        in: (coluna: string, valores: unknown[]) => {
          filtros.push([coluna, valores]);
          return q;
        },
        range: async (de: number, ate: number) => ({ data: erro ? null : detalhes.slice(de, ate + 1), error: erro }),
        then: (ok: (r: unknown) => unknown) =>
          ok({
            data: erro ? null : detalhes.filter((d) => filtros.every(([c, v]) => v.includes(d[c]))),
            error: erro,
          }),
      };
      return q;
    },
  } as never;
}

const P = "11111111-1111-4111-8111-111111111111";
const V = "22222222-2222-4222-8222-222222222222";
const SOLTO = "33333333-3333-4333-8333-333333333333";

describe("sinaisFixosQueTravamPreco", () => {
  it("o principal e a variação herdam o sinal fixo da família; produto comum não aparece", async () => {
    const mapa = await sinaisFixosQueTravamPreco(
      db([
        { product_id: P, pai_product_id: null, sinal_tipo: "fixo", sinal_cents: "30000" },
        { product_id: V, pai_product_id: P, sinal_tipo: null, sinal_cents: null },
      ]),
      "org",
      [P, V, SOLTO],
    );
    expect([...mapa.entries()].sort()).toEqual([
      [P, 30_000],
      [V, 30_000],
    ]);
  });

  it("sinal percentual não trava preço (ele acompanha o preço)", async () => {
    const mapa = await sinaisFixosQueTravamPreco(
      db([{ product_id: P, pai_product_id: null, sinal_tipo: "percentual", sinal_cents: null }]),
      "org",
      [P],
    );
    expect(mapa.size).toBe(0);
  });

  it("id que não é UUID nem chega ao banco", async () => {
    expect((await sinaisFixosQueTravamPreco(db([], { message: "não devia consultar" }), "org", ["x,y"])).size).toBe(0);
  });

  it("erro de leitura LANÇA — quem chama não grava sem conferir", async () => {
    await expect(sinaisFixosQueTravamPreco(db([], { message: "boom" }), "org", [P])).rejects.toThrow("boom");
  });
});

describe("todosOsDetalhes", () => {
  it("varredura além do teto lança, em vez de devolver metade como se fosse tudo", async () => {
    const muitos = Array.from({ length: 5 }, (_, i) => ({ product_id: `p${i}` }));
    await expect(todosOsDetalhes(db(muitos), "org", 2, 2)).rejects.toThrow("teto");
    expect((await todosOsDetalhes(db(muitos), "org", 2, 3)).size).toBe(5);
  });
});
