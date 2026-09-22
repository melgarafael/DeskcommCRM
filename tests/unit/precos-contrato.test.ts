import { describe, expect, it } from "vitest";

import {
  categoriaCreateSchema,
  itemDeTabelaSchema,
  precoEfetivo,
  tabelaCreateSchema,
} from "@/lib/schemas/precos";

/**
 * O CONTRATO DE CATEGORIAS E TABELAS — cerca do ATT.txt Fase 1.
 */
describe("precoEfetivo", () => {
  it("item da tabela vence tudo", () => {
    expect(precoEfetivo(10000, 10, 8000)).toBe(8000);
  });

  it("sem item, vale o desconto da tabela sobre a base", () => {
    // R$ 100,00 com 10% = R$ 90,00
    expect(precoEfetivo(10000, 10, null)).toBe(9000);
  });

  it("sem item nem desconto, vale a base", () => {
    expect(precoEfetivo(10000, 0, null)).toBe(10000);
  });

  it("arredonda, nunca trunca", () => {
    expect(precoEfetivo(3, 50, null)).toBe(2);
  });
});

describe("categoriaCreateSchema", () => {
  it("aceita raiz (sem pai)", () => {
    const r = categoriaCreateSchema.safeParse({ nome: "Bebidas" });
    expect(r.success).toBe(true);
  });

  it("recusa nome curto", () => {
    expect(categoriaCreateSchema.safeParse({ nome: "x" }).success).toBe(false);
  });
});

describe("tabelaCreateSchema", () => {
  it("desconto default é zero", () => {
    const r = tabelaCreateSchema.safeParse({ nome: "Atacado" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.desconto_pct).toBe(0);
  });

  it("recusa desconto acima de 100", () => {
    expect(tabelaCreateSchema.safeParse({ nome: "X", desconto_pct: 101 }).success).toBe(false);
  });
});

describe("itemDeTabelaSchema", () => {
  it("preco NULL significa 'vale o desconto da tabela'", () => {
    const r = itemDeTabelaSchema.safeParse({
      product_id: "00000000-0000-0000-0000-000000000000",
      preco_cents: null,
    });
    expect(r.success).toBe(true);
  });
});
