import { describe, expect, it } from "vitest";
import { totaisPorMoeda } from "./totais-por-moeda";

describe("totais da etapa por moeda", () => {
  it("mantém USD na soma dos negócios em dólares", () => {
    expect(totaisPorMoeda([
      { currency: "USD", value_cents: 64000 },
      { currency: "USD", value_cents: 9500 },
    ])).toEqual([{ currency: "USD", cents: 73500 }]);
  });
  it("não soma reais e dólares como se fossem a mesma unidade", () => {
    expect(totaisPorMoeda([
      { currency: "USD", value_cents: 18000 },
      { currency: "BRL", value_cents: 12000 },
      { currency: "USD", value_cents: null },
    ])).toEqual([
      { currency: "BRL", cents: 12000 },
      { currency: "USD", cents: 18000 },
    ]);
  });
  it("preserva o padrão BRL legado e omite totais vazios", () => {
    expect(totaisPorMoeda([{ currency: null, value_cents: 12345 }]))
      .toEqual([{ currency: "BRL", cents: 12345 }]);
    expect(totaisPorMoeda([])).toEqual([]);
    expect(totaisPorMoeda([{ currency: "USD", value_cents: 0 }])).toEqual([]);
  });
});
