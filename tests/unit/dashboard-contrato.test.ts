import { describe, expect, it } from "vitest";

import {
  contaComoVenda,
  emAberto,
  resumoDoPeriodo,
  serieDiaria,
  topProdutos,
  vendasPorOrigem,
  type LinhaDePedido,
} from "@/lib/comercial/dashboard";

/**
 * A MATEMÁTICA DO DASHBOARD — cerca do ATT.txt Fase 1 (F1.4).
 */

const P = (over: Partial<LinhaDePedido> = {}): LinhaDePedido => ({
  total_cents: 10000,
  status: "aprovado",
  origem: "vendedor",
  created_at: "2026-09-01T10:00:00Z",
  contact_id: null,
  ...over,
});

describe("emAberto / contaComoVenda", () => {
  it("aberto = não entregue nem cancelado", () => {
    expect(emAberto("rascunho")).toBe(true);
    expect(emAberto("aprovado")).toBe(true);
    expect(emAberto("entregue")).toBe(false);
    expect(emAberto("cancelado")).toBe(false);
  });

  it("rascunho não é venda; cancelado tampouco", () => {
    expect(contaComoVenda("rascunho")).toBe(false);
    expect(contaComoVenda("cancelado")).toBe(false);
    expect(contaComoVenda("aprovado")).toBe(true);
  });
});

describe("resumoDoPeriodo", () => {
  it("soma, conta e tira a média", () => {
    const r = resumoDoPeriodo(
      [P({ total_cents: 10000 }), P({ total_cents: 20000 }), P({ status: "rascunho", total_cents: 99999 })],
      "2026-09-01T00:00:00Z",
      "2026-10-01T00:00:00Z",
    );
    expect(r.faturamento_cents).toBe(30000);
    expect(r.qtd_pedidos).toBe(2);
    expect(r.ticket_medio_cents).toBe(15000);
  });

  it("período vazio zera sem dividir por zero", () => {
    const r = resumoDoPeriodo([], "2026-09-01T00:00:00Z", "2026-10-01T00:00:00Z");
    expect(r).toEqual({ faturamento_cents: 0, qtd_pedidos: 0, ticket_medio_cents: 0 });
  });

  it("fora do período não entra", () => {
    const r = resumoDoPeriodo(
      [P({ created_at: "2026-08-01T10:00:00Z", total_cents: 50000 })],
      "2026-09-01T00:00:00Z",
      "2026-10-01T00:00:00Z",
    );
    expect(r.faturamento_cents).toBe(0);
  });
});

describe("serieDiaria", () => {
  it("preenche zeros nos dias vazios e ordena", () => {
    const s = serieDiaria([P({ created_at: "2026-09-03T10:00:00Z", total_cents: 7000 })], "2026-09-03T12:00:00Z", 3);
    expect(s.map((p) => p.dia)).toEqual(["2026-09-01", "2026-09-02", "2026-09-03"]);
    expect(s[2]).toEqual({ dia: "2026-09-03", total_cents: 7000, qtd: 1 });
    expect(s[0]).toEqual({ dia: "2026-09-01", total_cents: 0, qtd: 0 });
  });
});

describe("vendasPorOrigem", () => {
  it("agrupa e ordena por valor", () => {
    const r = vendasPorOrigem(
      [P({ origem: "ia", total_cents: 5000 }), P({ origem: "vendedor", total_cents: 20000 }), P({ origem: "ia", total_cents: 3000 })],
      "2026-01-01T00:00:00Z",
    );
    expect(r[0]).toEqual({ origem: "vendedor", qtd: 1, total_cents: 20000 });
    expect(r[1]).toEqual({ origem: "ia", qtd: 2, total_cents: 8000 });
  });
});

describe("topProdutos", () => {
  it("agrega por nome e corta no limite", () => {
    const r = topProdutos(
      [
        { produto_nome: "A", quantidade: 1, subtotal_cents: 1000 },
        { produto_nome: "B", quantidade: 5, subtotal_cents: 9000 },
        { produto_nome: "A", quantidade: 2, subtotal_cents: 2000 },
      ],
      2,
    );
    expect(r).toEqual([
      { produto_nome: "B", quantidade: 5, total_cents: 9000 },
      { produto_nome: "A", quantidade: 3, total_cents: 3000 },
    ]);
  });
});
