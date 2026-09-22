import { describe, expect, it } from "vitest";

import {
  chavesParaSeletor,
  metricaMensal,
  vendasDiariasPorCategoria,
  vendasMensaisPorCategoria,
  type LinhaDePedido,
} from "@/lib/comercial/dashboard";

/**
 * O GRÁFICO HERÓI — mensal empilhado por categoria.
 */
type Ped = LinhaDePedido & { id: string };

const P = (over: Partial<Ped> = {}): Ped => ({
  id: "p1",
  total_cents: 10000,
  status: "aprovado",
  origem: "vendedor",
  created_at: "2026-09-10T10:00:00Z",
  contact_id: null,
  ...over,
});

const ITEM = (categoria: string, subtotal: number) => ({
  produto_nome: "X",
  quantidade: 1,
  subtotal_cents: subtotal,
  categoria,
});

describe("vendasMensaisPorCategoria", () => {
  it("empilha categorias lado a lado por mês", () => {
    const { serie, categorias } = vendasMensaisPorCategoria(
      [P({ id: "a", created_at: "2026-09-05T10:00:00Z", total_cents: 10000 })],
      { a: [ITEM("Bebidas", 6000), ITEM("Limpeza", 4000)] },
      "2026-09-20T00:00:00Z",
      2,
    );
    expect(serie.map((m) => m.mes)).toEqual(["2026-08", "2026-09"]);
    expect(serie[0]).toMatchObject({ total_cents: 0, qtd: 0 });
    expect(serie[1]?.por_categoria).toEqual({ Bebidas: 6000, Limpeza: 4000 });
    expect(categorias).toEqual(["Bebidas", "Limpeza"]);
  });

  it("item sem categoria não some — cai em Sem categoria", () => {
    const { serie } = vendasMensaisPorCategoria(
      [P({ id: "a", total_cents: 5000 })],
      { a: [ITEM("Sem categoria", 5000)] },
      "2026-09-20T00:00:00Z",
      1,
    );
    const somaCats = Object.values(serie[0]?.por_categoria ?? {}).reduce((s, v) => s + v, 0);
    expect(somaCats).toBe(5000);
  });

  it("rascunho e cancelado não entram", () => {
    const { serie } = vendasMensaisPorCategoria(
      [P({ id: "a", status: "rascunho", total_cents: 99999 })],
      {},
      "2026-09-20T00:00:00Z",
      1,
    );
    expect(serie[0]?.total_cents).toBe(0);
  });
});

describe("vendasDiariasPorCategoria", () => {
  it("todo dia do mês entra, zerado quando vazio", () => {
    const { dias } = vendasDiariasPorCategoria(
      [P({ id: "a", created_at: "2026-09-05T10:00:00Z", total_cents: 9000 })],
      { a: [ITEM("Bebidas", 9000)] },
      "2026-09",
    );
    expect(dias).toHaveLength(30);
    expect(dias[4]).toMatchObject({ dia: "2026-09-05", rotulo: "05/09", total_cents: 9000, qtd: 1 });
    expect(dias[0]).toMatchObject({ total_cents: 0, qtd: 0 });
    expect(dias[4]?.por_categoria).toEqual({ Bebidas: 9000 });
  });

  it("fevereiro tem 28 dias (2026 não é bissexto)", () => {
    const { dias } = vendasDiariasPorCategoria([], {}, "2026-02");
    expect(dias).toHaveLength(28);
  });

  it("pedido de outro mês não vaza", () => {
    const { dias } = vendasDiariasPorCategoria(
      [P({ id: "a", created_at: "2026-08-31T23:00:00Z", total_cents: 99999 })],
      {},
      "2026-09",
    );
    expect(dias.every((d) => d.total_cents === 0)).toBe(true);
  });
});

describe("chavesParaSeletor", () => {
  it("12 chaves terminando no mês atual", () => {
    const s = chavesParaSeletor("2026-09-20T00:00:00Z", 12);
    expect(s).toHaveLength(12);
    expect(s[11]).toEqual({ chave: "2026-09", rotulo: "set/26" });
    expect(s[0]).toEqual({ chave: "2025-10", rotulo: "out/25" });
  });
});

describe("metricaMensal", () => {
  it("variação mês contra mês", () => {
    const { serie } = vendasMensaisPorCategoria(
      [
        P({ id: "a", created_at: "2026-08-05T10:00:00Z", total_cents: 10000 }),
        P({ id: "b", created_at: "2026-09-05T10:00:00Z", total_cents: 15000 }),
      ],
      {},
      "2026-09-20T00:00:00Z",
      2,
    );
    const m = metricaMensal(serie);
    expect(m).toEqual({ mesAtual_cents: 15000, mesAnterior_cents: 10000, variacao_pct: 50 });
  });

  it("sem base anterior, variação é nula (não 0%, não infinito)", () => {
    const { serie } = vendasMensaisPorCategoria([], {}, "2026-09-20T00:00:00Z", 1);
    expect(metricaMensal(serie).variacao_pct).toBeNull();
  });
});
