import { describe, expect, it } from "vitest";

import { historicoDeCompra } from "./radar-compras";

function ped(id: string, dia: string, total: number, status = "faturado", origem = "vendedor"): {
  id: string; contact_id: string; total_cents: number; status: string; origem: string; dia: string;
} {
  return { id, contact_id: "c1", total_cents: total, status, origem, dia };
}

describe("historicoDeCompra", () => {
  it("exemplo da spec: recompra atrasada com atraso de 8 dias", () => {
    const pedidos = [
      ped("a", "2026-01-01", 500000),
      ped("b", "2026-01-23", 540000),
      ped("c", "2026-02-15", 490000),
      ped("d", "2026-03-08", 520000),
      ped("e", "2026-03-31", 510000),
    ];
    const h = historicoDeCompra(pedidos, "c1", "2026-04-30");
    expect(h.qtd_pedidos).toBe(5);
    expect(h.ultima_compra).toBe("2026-03-31");
    expect(h.dias_sem_compra).toBe(30);
    expect(h.intervalo_mediano_dias).toBe(22.5);
    expect(h.atraso_dias).toBe(8);
    expect(h.situacao).toBe("recompra_atrasada");
    expect(h.ticket_medio_cents).toBe(512000);
    expect(h.ultimos).toHaveLength(4);
  });

  it("pedido aberto vira em_voo, não perdido", () => {
    const pedidos = [
      ped("a", "2026-01-01", 100000),
      ped("b", "2026-01-26", 100000),
      { ...ped("c", "2026-04-28", 480000, "rascunho"), contact_id: "c1" },
    ];
    const h = historicoDeCompra(pedidos, "c1", "2026-05-10");
    expect(h.situacao).toBe("em_voo");
    expect(h.pedido_aberto_id).toBe("c");
  });

  it("cancelado não conta como compra, mas sinaliza sem nova", () => {
    const pedidos = [ped("a", "2026-01-01", 820000), ped("b", "2026-02-01", 820000, "cancelado")];
    const h = historicoDeCompra(pedidos, "c1", "2026-02-10");
    expect(h.qtd_pedidos).toBe(1);
    expect(h.situacao).toBe("cancelado_sem_nova");
    expect(h.cancelado_total_cents).toBe(820000);
  });

  it("orçamento não é compra, mas é oportunidade", () => {
    const pedidos = [ped("a", "2026-01-01", 100000), ped("b", "2026-04-28", 780000, "rascunho")];
    const h = historicoDeCompra(pedidos, "c1", "2026-05-06");
    expect(h.qtd_pedidos).toBe(1);
    expect(h.orcamento_total_cents).toBe(780000);
    expect(h.situacao).toBe("oportunidade_aberta");
  });

  it("sem pedidos é novo, com um é primeira compra", () => {
    expect(historicoDeCompra([], "c1", "2026-05-06").situacao).toBe("novo_sem_compras");
    expect(historicoDeCompra([ped("a", "2026-05-01", 5000)], "c1", "2026-05-06").situacao).toBe("primeira_compra");
  });

  it("pedido futuro não conta e duplicado conta uma vez", () => {
    const pedidos = [
      ped("a", "2026-05-01", 5000),
      ped("a", "2026-05-01", 5000),
      { ...ped("b", "2026-12-01", 9000), contact_id: "c1" },
    ];
    const h = historicoDeCompra(pedidos, "c1", "2026-05-06");
    expect(h.qtd_pedidos).toBe(1);
  });

  it("pedidos do mesmo dia são 1 ocasião: sem intervalo, sem atraso, primeira compra", () => {
    const pedidos = [
      ped("a", "2024-11-06", 8390),
      ped("b", "2024-11-06", 20200),
    ];
    const h = historicoDeCompra(pedidos, "c1", "2026-09-07");
    expect(h.qtd_pedidos).toBe(2);
    expect(h.intervalo_mediano_dias).toBeNull();
    expect(h.intervalo_medio_dias).toBeNull();
    expect(h.atraso_dias).toBe(0);
    expect(h.situacao).toBe("primeira_compra");
    expect(h.ticket_medio_cents).toBe(14295);
  });

  it("mesmo dia + compra posterior: o intervalo ignora o volume do dia", () => {
    const pedidos = [
      ped("a", "2024-11-06", 8390),
      ped("b", "2024-11-06", 20200),
      ped("c", "2024-12-06", 10000),
    ];
    const h = historicoDeCompra(pedidos, "c1", "2026-09-07");
    expect(h.intervalo_mediano_dias).toBe(30);
    expect(h.intervalo_medio_dias).toBe(30);
  });

  it("atraso maior que o intervalo vira alto risco", () => {
    const pedidos = [ped("a", "2026-01-01", 100000), ped("b", "2026-01-25", 100000)];
    const h = historicoDeCompra(pedidos, "c1", "2026-03-21");
    // intervalo 24, parado há 55 → atraso 31 > 24
    expect(h.situacao).toBe("em_risco");
    expect(h.atraso_dias).toBe(31);
  });

  it("canal predominante e última origem preservados", () => {
    const pedidos = [
      ped("a", "2026-01-01", 100, "faturado", "vendedor"),
      ped("b", "2026-02-01", 100, "faturado", "whatsapp"),
      ped("c", "2026-03-01", 100, "faturado", "vendedor"),
    ];
    expect(historicoDeCompra(pedidos, "c1", "2026-03-10").canal_predominante).toBe("vendedor");
  });
});
