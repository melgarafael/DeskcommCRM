import { describe, expect, it } from "vitest";

import {
  dividirParcelas,
  prazosDaCondicao,
  situacaoDe,
  somarPagamentos,
  validarPagamento,
} from "./financeiro";

describe("prazosDaCondicao", () => {
  it("30/60/90 vira 3 prazos; à vista e texto solto viram null", () => {
    expect(prazosDaCondicao("30/60/90")).toEqual([30, 60, 90]);
    expect(prazosDaCondicao("28 dias")).toBeNull();
    expect(prazosDaCondicao("à vista")).toBeNull();
    expect(prazosDaCondicao(null)).toBeNull();
  });
});

describe("dividirParcelas", () => {
  it("1000 em 3x: 333,33 + 333,33 + 333,34 com vencimentos", () => {
    const ps = dividirParcelas(100000, "30/60/90", "2026-09-01");
    expect(ps.map((p) => p.valor_cents)).toEqual([33333, 33333, 33334]);
    expect(ps.map((p) => p.vencimento)).toEqual(["2026-10-01", "2026-10-31", "2026-11-30"]);
    expect(ps.reduce((s, p) => s + p.valor_cents, 0)).toBe(100000);
  });

  it("à vista vira parcela única no dia da emissão", () => {
    expect(dividirParcelas(50000, null, "2026-09-01")).toEqual([
      { n: 1, valor_cents: 50000, vencimento: "2026-09-01" },
    ]);
  });
});

describe("situacaoDe", () => {
  const base = { valor_original_cents: 100000, vencimento: "2026-09-05" } as const;
  it("pago, parcial, aberto e vencido com dias de atraso", () => {
    expect(situacaoDe({ ...base, status: "aberto" }, [{ valor_cents: 100000 }], "2026-09-08").situacao).toBe("pago");
    const parcial = situacaoDe({ ...base, status: "aberto" }, [{ valor_cents: 40000 }], "2026-09-08");
    expect(parcial.situacao).toBe("parcial");
    expect(parcial.saldo_cents).toBe(60000);
    expect(situacaoDe({ ...base, status: "aberto" }, [], "2026-09-01").situacao).toBe("aberto");
    const vencido = situacaoDe({ ...base, status: "aberto" }, [], "2026-09-08");
    expect(vencido.situacao).toBe("vencido");
    expect(vencido.diasAtraso).toBe(3);
    expect(situacaoDe({ ...base, status: "cancelado" }, [], "2026-09-08").situacao).toBe("cancelado");
  });
});

describe("validarPagamento", () => {
  it("teto do caixa: nunca acima do saldo, nunca zerado, nunca em conta fechada", () => {
    expect(validarPagamento(100001, 100000)).toBe("acima_do_saldo");
    expect(validarPagamento(0, 100000)).toBe("valor_invalido");
    expect(validarPagamento(-5, 100000)).toBe("valor_invalido");
    expect(validarPagamento(1, 0)).toBe("recebivel_fechado");
    expect(validarPagamento(40000, 100000)).toBeNull();
    expect(validarPagamento(100000, 100000)).toBeNull();
  });

  it("soma de pagamentos sustenta o saldo", () => {
    expect(somarPagamentos([{ valor_cents: 400 }, { valor_cents: 600 }])).toBe(1000);
  });
});
