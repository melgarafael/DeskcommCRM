import { describe, expect, it } from "vitest";

import {
  contaNoRelatorio,
  curvaABC,
  paraCSV,
  vendasPorCliente,
  vendasPorProduto,
  vendasPorVendedor,
  type VendaAgregavel,
} from "@/lib/comercial/relatorios";

/**
 * A MATEMÁTICA DOS RELATÓRIOS — cerca do ATT.txt F5 (sem B2B).
 */
const V = (over: Partial<VendaAgregavel> = {}): VendaAgregavel => ({
  total_cents: 10000,
  status: "aprovado",
  created_at: "2026-09-01T10:00:00Z",
  vendedor_user_id: "vend-1",
  contact_id: "cont-1",
  cliente_nome: "Mercado",
  ...over,
});

const INICIO = "2026-09-01T00:00:00Z";
const FIM = "2026-10-01T00:00:00Z";

describe("agrupamentos", () => {
  it("rascunho e cancelado não contam", () => {
    expect(contaNoRelatorio("rascunho")).toBe(false);
    expect(contaNoRelatorio("cancelado")).toBe(false);
    expect(contaNoRelatorio("entregue")).toBe(true);
  });

  it("vendedor sem nome vira Equipe; sem vendedor, Sem vendedor", () => {
    const r = vendasPorVendedor(
      [V({ vendedor_user_id: "x" }), V({ vendedor_user_id: null })],
      INICIO,
      FIM,
      {},
    );
    expect(r.map((l) => l.rotulo).sort()).toEqual(["Equipe", "Sem vendedor"]);
  });

  it("cliente avulso (sem contact_id) agrupa por nome", () => {
    const r = vendasPorCliente(
      [V({ contact_id: null, cliente_nome: "Avulso" }), V({ contact_id: null, cliente_nome: "Avulso" })],
      INICIO,
      FIM,
    );
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ rotulo: "Avulso", qtd: 2, total_cents: 20000 });
  });

  it("produto soma quantidade e valor", () => {
    const r = vendasPorProduto([
      { produto_nome: "A", quantidade: 1, subtotal_cents: 1000 },
      { produto_nome: "A", quantidade: 2, subtotal_cents: 2000 },
    ]);
    expect(r[0]).toMatchObject({ rotulo: "A", qtd: 3, total_cents: 3000 });
  });
});

describe("curvaABC", () => {
  it("80/15/5 clássico", () => {
    const r = curvaABC([
      { chave: "a", rotulo: "A", qtd: 1, total_cents: 8000, ticket_medio_cents: 8000 },
      { chave: "b", rotulo: "B", qtd: 1, total_cents: 1500, ticket_medio_cents: 1500 },
      { chave: "c", rotulo: "C", qtd: 1, total_cents: 500, ticket_medio_cents: 500 },
    ]);
    expect(r.map((l) => l.classe)).toEqual(["A", "B", "C"]);
  });

  it("vazio não divide por zero", () => {
    expect(curvaABC([])).toEqual([]);
  });
});

describe("paraCSV", () => {
  it("separador BR com escape", () => {
    const csv = paraCSV(["Nome", "Total"], [["Mercado; Matriz", 100], ['Diz "oi"', 200]]);
    expect(csv).toBe('Nome;Total\r\n"Mercado; Matriz";100\r\n"Diz ""oi""";200');
  });
});
