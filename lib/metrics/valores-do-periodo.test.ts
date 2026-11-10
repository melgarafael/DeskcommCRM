/**
 * As duas parcelas do período (fatia 2, item 1, da issue #3602).
 *
 * O que este arquivo cobra, e por quê:
 *
 *   · "vendido único" e "recorrência nova mensal" são números SEPARADOS — não
 *     existe campo com a soma das duas, porque somar é o defeito da issue;
 *   · `closed_at` fora da janela não entra em NENHUMA das duas;
 *   · negócio sem `recurring_value_cents` não vira recorrência (retrocompat:
 *     quem não preenche o campo vê o painel de antes);
 *   · recorrente sem periodicidade nasce MENSAL (regra 2 da régua da fatia 1) e
 *     periodicidade desconhecida NÃO é somada como se fosse mensal;
 *   · moeda diferente não soma: as parcelas do topo viram `null` e o corte
 *     honesto é `por_moeda`.
 */
import { describe, expect, it } from "vitest";

import { type NegocioComValor, separarValoresDoPeriodo } from "./valores-do-periodo";

const JANELA = { from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" };

function ganho(parcial: Partial<NegocioComValor> = {}): NegocioComValor {
  return {
    status: "won",
    closed_at: "2026-09-10T12:00:00.000Z",
    currency: "BRL",
    value_cents: null,
    recurring_value_cents: null,
    recurring_period: null,
    ...parcial,
  };
}

describe("separarValoresDoPeriodo", () => {
  it("devolve as duas parcelas SEPARADAS: 3.000 de único e 500 de recorrência nova", () => {
    const valores = separarValoresDoPeriodo({
      janela: JANELA,
      negocios: [
        ganho({ value_cents: 300000, recurring_value_cents: 50000, recurring_period: "monthly" }),
        ganho({ value_cents: null }),
      ],
    });

    expect(valores.unico.centavos).toBe(300000);
    expect(valores.unico.negocios).toBe(2);
    expect(valores.recorrente_mensal.centavos).toBe(50000);
    expect(valores.recorrente_mensal.negocios).toBe(1);
    expect(valores.negocios_com_recorrencia).toBe(1);
    // A prova da fronteira: nada na resposta soma as duas parcelas.
    expect(valores).not.toHaveProperty("total");
    expect(valores).not.toHaveProperty("total_centavos");
    expect(Object.values(valores.unico)).not.toContain(350000);
  });

  it("recorrente sem periodicidade nasce MENSAL (a régua da fatia 1)", () => {
    const valores = separarValoresDoPeriodo({
      janela: JANELA,
      negocios: [ganho({ recurring_value_cents: 50000, recurring_period: null })],
    });
    expect(valores.recorrente_mensal.centavos).toBe(50000);
  });

  it("periodicidade que a v1 não conhece não é somada como se fosse mensal", () => {
    const valores = separarValoresDoPeriodo({
      janela: JANELA,
      negocios: [ganho({ recurring_value_cents: 120000, recurring_period: "yearly" })],
    });
    expect(valores.recorrente_mensal.centavos).toBe(0);
    // Mas o negócio continua contado como "tem recorrência": sumir com ele
    // seria esconder dado que existe.
    expect(valores.negocios_com_recorrencia).toBe(1);
  });

  it("negócio GANHO fora da janela não conta em nenhuma das duas parcelas", () => {
    const valores = separarValoresDoPeriodo({
      janela: JANELA,
      negocios: [
        ganho({
          closed_at: "2026-08-31T23:59:59.000Z",
          value_cents: 300000,
          recurring_value_cents: 50000,
        }),
        ganho({
          closed_at: "2026-10-01T00:00:00.000Z",
          value_cents: 999900,
          recurring_value_cents: 99900,
        }),
      ],
    });
    expect(valores.unico.centavos).toBe(0);
    expect(valores.unico.negocios).toBe(0);
    expect(valores.recorrente_mensal.centavos).toBe(0);
    expect(valores.negocios_com_recorrencia).toBe(0);
  });

  it("aberto e perdido não contam, mesmo com recorrência preenchida", () => {
    const valores = separarValoresDoPeriodo({
      janela: JANELA,
      negocios: [
        ganho({ status: "open", closed_at: null, value_cents: 100000, recurring_value_cents: 10000 }),
        ganho({ status: "lost", value_cents: 200000, recurring_value_cents: 20000 }),
      ],
    });
    expect(valores.unico.centavos).toBe(0);
    expect(valores.recorrente_mensal.centavos).toBe(0);
    expect(valores.negocios_com_recorrencia).toBe(0);
  });

  it("retrocompatibilidade: sem recorrência, o único é o de sempre e a recorrência é zero", () => {
    const valores = separarValoresDoPeriodo({
      janela: JANELA,
      negocios: [ganho({ value_cents: 300000 }), ganho({ value_cents: 250000 })],
    });
    expect(valores.unico.centavos).toBe(550000);
    expect(valores.recorrente_mensal.centavos).toBe(0);
    expect(valores.recorrente_mensal.negocios).toBe(0);
    expect(valores.negocios_com_recorrencia).toBe(0);
    expect(valores.moeda).toBe("BRL");
    expect(valores.moeda_mista).toBe(false);
  });

  it("moeda diferente NÃO soma: o topo fica nulo e o corte é por moeda", () => {
    const valores = separarValoresDoPeriodo({
      janela: JANELA,
      negocios: [
        ganho({ currency: "BRL", value_cents: 300000, recurring_value_cents: 50000 }),
        ganho({ currency: "USD", value_cents: 100000, recurring_value_cents: 20000 }),
      ],
    });
    expect(valores.moeda).toBeNull();
    expect(valores.moeda_mista).toBe(true);
    expect(valores.unico.centavos).toBeNull();
    expect(valores.recorrente_mensal.centavos).toBeNull();
    expect(typeof valores.nota).toBe("string");
    expect(valores.por_moeda).toHaveLength(2);
    const brl = valores.por_moeda.find((b) => b.moeda === "BRL")!;
    expect(brl.unico_centavos).toBe(300000);
    expect(brl.recorrente_mensal_centavos).toBe(50000);
  });

  it("a moeda da organização é a reserva quando o negócio não traz a própria", () => {
    const valores = separarValoresDoPeriodo({
      janela: JANELA,
      moedaDaOrganizacao: "PYG",
      negocios: [ganho({ currency: null, value_cents: 300000 })],
    });
    expect(valores.moeda).toBe("PYG");
    expect(valores.por_moeda).toHaveLength(1);
  });

  it("leitura truncada é PISO declarado, não total silencioso", () => {
    const valores = separarValoresDoPeriodo({
      janela: JANELA,
      negocios: [ganho({ value_cents: 300000 })],
      truncado: true,
    });
    expect(valores.truncado).toBe(true);
    expect(typeof valores.nota).toBe("string");
    expect(valores.nota).toContain("piso");
  });

  it("janela sem ganho nenhum é zero medido, e a base viaja junto", () => {
    const valores = separarValoresDoPeriodo({ janela: JANELA, negocios: [] });
    expect(valores.unico).toEqual({ centavos: 0, negocios: 0 });
    expect(valores.recorrente_mensal).toEqual({ centavos: 0, negocios: 0 });
    expect(valores.por_moeda).toEqual([]);
    expect(valores.nota).toBeNull();
    expect(valores.base).toContain("GANHOS");
  });
});
