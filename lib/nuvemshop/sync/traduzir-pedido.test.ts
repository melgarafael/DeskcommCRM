import { describe, expect, it } from "vitest";
import { pedidoNuvemshopSchema, type PedidoNuvemshop } from "./pedido-nuvemshop";
import { centavosDe, ErroDeTraducao, traduzirPedido } from "./traduzir-pedido";

function pedido(over: Partial<PedidoNuvemshop> = {}): PedidoNuvemshop {
  return pedidoNuvemshopSchema.parse({
    id: 555,
    number: 1001,
    status: "open",
    payment_status: "pending",
    shipping_status: "unpacked",
    total: "150.90",
    subtotal: "140.00",
    discount: "0.00",
    shipping_cost_customer: "10.90",
    currency: "BRL",
    gateway: "pix",
    shipping_tracking_number: null,
    created_at: "2026-09-01T10:00:00+0000",
    updated_at: "2026-09-02T11:00:00+0000",
    contact_email: "ana@ex.com",
    contact_phone: "+5511999990000",
    contact_identification: "123.456.789-09",
    contact_name: "Ana",
    billing_address: "Rua Secreta 1",
    customer: { id: 77, name: "Ana", email: "ana@ex.com", identification: "12345678909" },
    products: [{ product_id: 1, variant_id: 2, name: "Camisa", quantity: 2, price: "70.00", sku: "X" }],
    ...over,
  });
}

describe("centavosDe", () => {
  it.each([
    ["0.10", 10],
    ["1234.5", 123450],
    ["99", 9900],
    ["150.90", 15090],
    ["0", 0],
    ["10.005", 1001],
    [12.3, 1230],
  ])("%s → %s", (entrada, esperado) => {
    expect(centavosDe(entrada)).toBe(esperado);
  });
  it.each(["", "abc", "-1.00", "1,50", "NaN"])("recusa %s", (entrada) => {
    expect(centavosDe(entrada)).toBeNull();
  });
});

describe("traduzirPedido — status", () => {
  it.each([
    [{ status: "cancelled", payment_status: "paid" }, "cancelled"],
    [{ payment_status: "voided" }, "cancelled"],
    [{ payment_status: "refunded", shipping_status: "delivered" }, "refunded"],
    [{ payment_status: "paid", shipping_status: "delivered" }, "delivered"],
    [{ payment_status: "paid", shipping_status: "shipped" }, "shipped"],
    [{ payment_status: "paid", shipping_status: "unpacked" }, "paid"],
    [{ payment_status: "partially_refunded", shipping_status: "unpacked" }, "paid"],
    [{ payment_status: "authorized" }, "pending"],
    [{ payment_status: "partially_paid" }, "pending"],
    [{ payment_status: "abandoned" }, "pending"],
    [{ payment_status: "valor_novo_que_nao_existe" }, "pending"],
  ] as const)("%j → %s", (over, esperado) => {
    expect(traduzirPedido(pedido(over)).status).toBe(esperado);
  });
});

describe("traduzirPedido — envio", () => {
  it.each([
    ["unpacked", "unpacked"],
    ["partially_packed", "packed"],
    ["partially_fulfilled", "packed"],
    ["unshipped", "packed"],
    ["shipped", "shipped"],
    ["delivered", "delivered"],
    ["outra_coisa", null],
    [null, null],
  ] as const)("%s → %s", (entrada, esperado) => {
    expect(traduzirPedido(pedido({ shipping_status: entrada })).fulfillment_status).toBe(esperado);
  });
});

describe("traduzirPedido — campos", () => {
  it("mapeia ids, valores e datas", () => {
    const l = traduzirPedido(pedido());
    expect(l).toMatchObject({
      external_provider: "nuvemshop",
      external_id: "555",
      customer_external_id: "77",
      total_cents: 15090,
      currency: "BRL",
      payment_method: "pix",
      tracking_code: null,
      ordered_at: "2026-09-01T10:00:00.000Z",
      updated_at_remote: "2026-09-02T11:00:00.000Z",
    });
  });
  it("moeda ausente vira BRL", () => {
    expect(traduzirPedido(pedido({ currency: null })).currency).toBe("BRL");
  });
  it("payload é projeção: guarda produtos e status brutos, sem PII", () => {
    const { payload } = traduzirPedido(pedido());
    expect(payload).toMatchObject({
      number: 1001,
      products: [{ product_id: 1, variant_id: 2, name: "Camisa", quantity: 2, price: "70.00" }],
      origem: { status: "open", payment_status: "pending", shipping_status: "unpacked" },
    });
    const texto = JSON.stringify(payload);
    expect(texto).not.toContain("Rua Secreta");
    expect(texto).not.toContain("ana@ex.com");
    expect(texto).not.toContain("12345678909");
    expect(texto).not.toContain("sku");
  });
  it("total inválido lança ErroDeTraducao", () => {
    expect(() => traduzirPedido(pedido({ total: "abc" }))).toThrow(ErroDeTraducao);
  });
  it("data inválida lança ErroDeTraducao", () => {
    expect(() => traduzirPedido(pedido({ created_at: "ontem" }))).toThrow(ErroDeTraducao);
  });
});
