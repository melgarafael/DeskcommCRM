import { describe, expect, it } from "vitest";

import {
  badgeDaOrigem,
  calcularParcelas,
  itensPatchSchema,
  pedidoCreateSchema,
  pedidoPatchSchema,
  ROTULO_DO_STATUS,
  STATUS_DO_PEDIDO,
  subtotalDoItem,
} from "@/lib/schemas/pedidos";

/**
 * O CONTRATO DOS PEDIDOS — cerca do ATT.txt Fase 2.
 *
 * Dinheiro em centavos não admite "quase": cada caso aqui fixa um número.
 * Quem mudar `subtotalDoItem` e quebrar um total vai ler exatamente qual.
 */
describe("subtotalDoItem", () => {
  it("multiplica quantidade × preço sem desconto", () => {
    expect(subtotalDoItem(2, 549900, 0)).toBe(1099800);
  });

  it("aplica desconto percentual", () => {
    // 2 × R$ 100,00 com 10% = R$ 180,00
    expect(subtotalDoItem(2, 10000, 10)).toBe(18000);
  });

  it("arredonda meio centavo para cima, nunca trunca", () => {
    // 1 × R$ 0,03 com 50% = 1,5 centavo → 2, não 1. Truncar some centavos
    // no pedido inteiro sem ninguém ver.
    expect(subtotalDoItem(1, 3, 50)).toBe(2);
  });

  it("100% de desconto zera", () => {
    expect(subtotalDoItem(5, 10000, 100)).toBe(0);
  });
});

describe("pedidoCreateSchema", () => {
  const base = {
    cliente_nome: "Mercado Central",
    itens: [{ product_id: null, quantidade: 2, preco_unit_cents: 10000, desconto_pct: 0 }],
  };

  it("aceita o mínimo viável com defaults", () => {
    const r = pedidoCreateSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.status).toBe("rascunho");
      expect(r.data.origem).toBe("vendedor");
      expect(r.data.moeda).toBe("BRL");
    }
  });

  it("recusa pedido sem item", () => {
    expect(pedidoCreateSchema.safeParse({ ...base, itens: [] }).success).toBe(false);
  });

  it("recusa status fora do vocabulário", () => {
    expect(
      pedidoCreateSchema.safeParse({ ...base, status: "teletransportado" }).success,
    ).toBe(false);
  });

  it("recusa desconto maior que 100% no item", () => {
    expect(
      pedidoCreateSchema.safeParse({
        ...base,
        itens: [{ product_id: null, quantidade: 1, preco_unit_cents: 100, desconto_pct: 101 }],
      }).success,
    ).toBe(false);
  });

  it("PATCH nunca aceita itens nem totais", () => {
    const r = pedidoPatchSchema.safeParse({ status: "aprovado", total_cents: 999 });
    expect(r.success).toBe(true);
    if (r.success) {
      expect("total_cents" in r.data).toBe(false);
      expect("itens" in r.data).toBe(false);
    }
  });
});

describe("calcularParcelas", () => {
  it("30/60/90 divide com resto na última", () => {
    const p = calcularParcelas(1000, "30/60/90 dias");
    expect(p).toHaveLength(3);
    expect(p[0]?.valor_cents).toBe(333);
    expect(p[2]?.valor_cents).toBe(334);
    expect(p[0]?.n).toBe(1);
  });

  it("condição simples não parcela", () => {
    expect(calcularParcelas(1000, "28 dias")).toEqual([]);
    expect(calcularParcelas(1000, null)).toEqual([]);
  });
});

describe("itensPatchSchema", () => {
  it("vazio total é recusado na rota (aqui ao menos parseia)", () => {
    const r = itensPatchSchema.safeParse({ adicionar: [], remover: [], ajustar: [] });
    expect(r.success).toBe(true);
  });
});

describe("badges e rótulos", () => {
  it("todo status tem rótulo", () => {
    for (const s of STATUS_DO_PEDIDO) {
      expect(ROTULO_DO_STATUS[s]).toBeTruthy();
    }
  });

  it("origens conhecidas têm badge colorido", () => {
    for (const o of ["ia", "vendedor", "whatsapp", "b2b"]) {
      expect(badgeDaOrigem(o).rotulo).toBeTruthy();
      expect(badgeDaOrigem(o).classe).not.toContain("muted");
    }
  });

  it("origem desconhecida cai no neutro, nunca quebra", () => {
    const b = badgeDaOrigem("pompo-carreiro");
    expect(b.rotulo).toBe("pompo-carreiro");
    expect(b.classe).toContain("muted");
  });
});
