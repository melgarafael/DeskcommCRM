import { describe, expect, it } from "vitest";

import { comissaoDoItem, comissaoDoPedido } from "./comissao";

describe("comissaoDoItem", () => {
  it("aplica o % com round, NULL e 0 zeram", () => {
    expect(comissaoDoItem(10000, 8)).toBe(800);
    expect(comissaoDoItem(10000, null)).toBe(0);
    expect(comissaoDoItem(10000, 0)).toBe(0);
    expect(comissaoDoItem(199, 70)).toBe(139);
  });
});

describe("comissaoDoPedido", () => {
  it("soma por item e separa a base com regra", () => {
    const r = comissaoDoPedido([
      { subtotal_cents: 18000, comissao_pct: 10 },
      { subtotal_cents: 4050, comissao_pct: null },
    ]);
    expect(r).toEqual({ cents: 1800, base_cents: 18000 });
  });
});
