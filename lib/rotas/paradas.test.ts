import { describe, expect, it } from "vitest";

import { agruparParadas, type ItemDaCargaParaParada } from "./paradas";

function item(parcial: Partial<ItemDaCargaParaParada> & { order_id: string }): ItemDaCargaParaParada {
  return {
    shipment_order_id: `so-${parcial.order_id}`,
    sequencia: 1,
    status: "na_carga",
    numero: 1000,
    cliente_nome: "Cliente",
    contact_id: null,
    contato_nome: null,
    fone: null,
    endereco_entrega: null,
    latitude: null,
    longitude: null,
    geo_status: "pendente",
    geo_fonte: null,
    total_cents: 100,
    ...parcial,
  };
}

describe("agruparParadas", () => {
  it("dois pedidos do mesmo cliente viram uma parada só", () => {
    const paradas = agruparParadas([
      item({ order_id: "a", contact_id: "c1", cliente_nome: "Mercado A", numero: 1021, sequencia: 2 }),
      item({ order_id: "b", contact_id: "c1", cliente_nome: "Mercado A", numero: 1028, sequencia: 1 }),
    ]);
    expect(paradas).toHaveLength(1);
    expect(paradas[0]?.pedidos.map((p) => p.numero).sort()).toEqual([1021, 1028]);
    expect(paradas[0]?.total_cents).toBe(200);
  });

  it("clientes diferentes não se misturam e a ordem inicial é a menor sequência", () => {
    const paradas = agruparParadas([
      item({ order_id: "a", contact_id: "c1", cliente_nome: "A", sequencia: 3 }),
      item({ order_id: "b", contact_id: "c2", cliente_nome: "B", sequencia: 1 }),
    ]);
    expect(paradas.map((p) => p.cliente)).toEqual(["B", "A"]);
  });

  it("avulso agrupa pelo nome normalizado", () => {
    const paradas = agruparParadas([
      item({ order_id: "a", cliente_nome: "João  Silva" }),
      item({ order_id: "b", cliente_nome: "joão silva" }),
    ]);
    expect(paradas).toHaveLength(1);
  });

  it("primeiro endereço não-vazio vence", () => {
    const paradas = agruparParadas([
      item({ order_id: "a", contact_id: "c1", endereco_entrega: null }),
      item({ order_id: "b", contact_id: "c1", endereco_entrega: "Rua X, 10" }),
    ]);
    expect(paradas[0]?.endereco).toBe("Rua X, 10");
  });
});
