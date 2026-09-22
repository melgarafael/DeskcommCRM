import { describe, expect, it } from "vitest";

import {
  aCobrarPorCondicao,
  classificarCondicao,
  resumoDoFechamento,
  type ParadaFechamento,
} from "@/lib/comercial/fechamento-expedicao-pdf";

function parada(sobre: Partial<ParadaFechamento>): ParadaFechamento {
  return {
    sequencia: 1,
    numero: 1,
    cliente_nome: "Cliente",
    endereco_entrega: null,
    total_cents: 10000,
    condicao: null,
    situacao: "entregue",
    motivo: null,
    entregue_em: null,
    volumes: 0,
    pago_cents: 0,
    ...sobre,
  };
}

describe("resumoDoFechamento", () => {
  it("soma faturado, abate antecipado e separa devolvido", () => {
    const r = resumoDoFechamento([
      parada({ sequencia: 1, total_cents: 10000, pago_cents: 10000, volumes: 2 }),
      parada({ sequencia: 2, total_cents: 20000, pago_cents: 5000, volumes: 3 }),
      parada({ sequencia: 3, total_cents: 30000, situacao: "devolvido", volumes: 5 }),
      parada({ sequencia: 4, total_cents: 40000, situacao: "em_rota", volumes: 1 }),
    ]);
    expect(r.totalFaturado).toBe(100000);
    expect(r.pagoAntecipado).toBe(15000);
    expect(r.devolvido).toBe(30000);
    // A cobrar: só não-devolvidos, abatendo o antecipado.
    expect(r.aCobrar).toBe(0 + 15000 + 40000);
    expect(r.volumes).toBe(11);
    expect(r.concluidas).toBe(3);
    expect(r.pendentes).toBe(1);
  });

  it("antecipado nunca abate além do total do pedido", () => {
    const r = resumoDoFechamento([parada({ total_cents: 10000, pago_cents: 99999 })]);
    expect(r.pagoAntecipado).toBe(10000);
    expect(r.aCobrar).toBe(0);
  });

  it("carga vazia zera tudo", () => {
    expect(resumoDoFechamento([])).toEqual({
      totalFaturado: 0,
      pagoAntecipado: 0,
      aCobrar: 0,
      devolvido: 0,
      volumes: 0,
      concluidas: 0,
      pendentes: 0,
    });
  });
});

describe("classificarCondicao", () => {
  it("acha dinheiro, PIX, cartão, boleto e prazo sem acento nem caixa", () => {
    expect(classificarCondicao("DINHEIRO")).toBe("Dinheiro");
    expect(classificarCondicao("Pix agendado")).toBe("PIX");
    expect(classificarCondicao("Cartão de crédito")).toBe("Cartão");
    expect(classificarCondicao("boleto 14 dias")).toBe("Boleto");
    expect(classificarCondicao("30/60")).toBe("A prazo");
    expect(classificarCondicao("A VISTA")).toBe("Pago antecipado");
    expect(classificarCondicao(null)).toBe("Outros");
    expect(classificarCondicao("combinar depois")).toBe("Outros");
  });
});

describe("aCobrarPorCondicao", () => {
  it("agrupa o que falta por condição, fora devolvidos e quitados", () => {
    const grupos = aCobrarPorCondicao([
      parada({ numero: 1, total_cents: 10000, condicao: "dinheiro" }),
      parada({ numero: 2, total_cents: 20000, condicao: "PIX", pago_cents: 5000 }),
      parada({ numero: 3, total_cents: 30000, condicao: "dinheiro", situacao: "devolvido" }),
      parada({ numero: 4, total_cents: 40000, condicao: "dinheiro", pago_cents: 40000 }),
    ]);
    expect(grupos).toEqual([
      { condicao: "PIX", valor_cents: 15000 },
      { condicao: "Dinheiro", valor_cents: 10000 },
    ]);
  });
});
