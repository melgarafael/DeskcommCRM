import { describe, expect, it } from "vitest";

import {
  cicloMedioDias,
  clientesNoMes,
  curvaABC,
  situacaoDaCarteira,
} from "./carteira";

describe("cicloMedioDias", () => {
  it("mediana dos intervalos por cliente, não média global", () => {
    const pedidos = [
      { contact_id: "a", total_cents: 100, status: "faturado", dia: "2026-01-01" },
      { contact_id: "a", total_cents: 100, status: "faturado", dia: "2026-01-31" },
      { contact_id: "b", total_cents: 100, status: "faturado", dia: "2026-01-01" },
      { contact_id: "b", total_cents: 100, status: "faturado", dia: "2026-04-01" },
    ];
    // intervalos: 30 e 90 → mediana 60.
    expect(cicloMedioDias(pedidos)).toBe(60);
  });

  it("ignora rascunho e cancelado, e cai em 90 sem histórico", () => {
    expect(cicloMedioDias([])).toBe(90);
    expect(
      cicloMedioDias([{ contact_id: "a", total_cents: 1, status: "rascunho", dia: "2026-01-01" }]),
    ).toBe(90);
  });
});

describe("situacaoDaCarteira", () => {
  const pedidos = [
    { contact_id: "a", total_cents: 100, status: "faturado", dia: "2026-08-20" },
    { contact_id: "b", total_cents: 100, status: "faturado", dia: "2026-06-01" },
    { contact_id: "c", total_cents: 100, status: "faturado", dia: "2025-01-01" },
  ];
  it("classifica por múltiplos do ciclo", () => {
    const s = situacaoDaCarteira({ pedidos, totalContatos: 5, hoje: "2026-09-06", cicloDias: 30 });
    expect(s).toEqual({ ativos: 1, inativosRecentes: 0, inativosAntigos: 2, prospects: 2, cicloDias: 30 });
  });
});

describe("clientesNoMes", () => {
  it("conta distintos, só vendas", () => {
    const pedidos = [
      { contact_id: "a", total_cents: 1, status: "faturado", dia: "2026-09-01" },
      { contact_id: "a", total_cents: 1, status: "faturado", dia: "2026-09-02" },
      { contact_id: "b", total_cents: 1, status: "rascunho", dia: "2026-09-01" },
    ];
    expect(clientesNoMes(pedidos, "2026-09")).toBe(1);
  });
});

describe("curvaABC", () => {
  it("corta em 80/95", () => {
    const r = curvaABC([
      { chave: "a", cents: 80 },
      { chave: "b", cents: 15 },
      { chave: "c", cents: 5 },
    ]);
    expect(r.total).toBe(100);
    expect(r.faixas[0]).toMatchObject({ faixa: "A", clientes: 1, cents: 80 });
    expect(r.faixas[1]).toMatchObject({ faixa: "B", clientes: 1, cents: 15 });
    expect(r.faixas[2]).toMatchObject({ faixa: "C", clientes: 1, cents: 5 });
  });
});
