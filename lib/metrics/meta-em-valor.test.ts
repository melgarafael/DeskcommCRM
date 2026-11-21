/**
 * A régua da meta em VALOR (issue #4796): janela, valor fantasma e projeção.
 *
 * Cada caso aqui é uma sabotagem possível, e o teste diz qual:
 *   - trocar `closed_at` por `created_at` quebra o caso da janela;
 *   - somar negócio não ganho quebra o caso do status;
 *   - tratar valor nulo/zero como R$ 0 quebra o caso do fantasma.
 */
import { describe, expect, it } from "vitest";

import {
  INDICADOR_PADRAO,
  normalizarIndicador,
  progressoDaMeta,
  projetarFimDaJanela,
  somarValorRealizado,
  type NegocioDaMeta,
} from "./meta-em-valor";

const JANELA = { from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" };

function negocio(parcial: Partial<NegocioDaMeta> = {}): NegocioDaMeta {
  return {
    status: "won",
    closed_at: "2026-09-10T12:00:00.000Z",
    pipeline_id: null,
    owner_user_id: "u1",
    currency: "BRL",
    value_cents: 300_000,
    ...parcial,
  };
}

describe("somarValorRealizado", () => {
  it("soma os ganhos fechados na janela, com `closed_at` como régua", () => {
    const soma = somarValorRealizado({
      negocios: [
        negocio({ value_cents: 300_000 }),
        negocio({ closed_at: "2026-09-30T23:59:00.000Z", value_cents: 800_000 }),
        // `created_at` dentro da janela e `closed_at` em agosto: a venda é de
        // agosto — se a régua fosse `created_at`, ele entraria.
        negocio({ closed_at: "2026-08-31T23:00:00.000Z", value_cents: 5_000_000 }),
        // Fechado no 1º instante de outubro: o limite de cima é EXCLUSIVO.
        negocio({ closed_at: "2026-10-01T00:00:00.000Z", value_cents: 7_000_000 }),
      ],
      janela: JANELA,
      moeda: "BRL",
    });
    expect(soma.centavos).toBe(1_100_000);
    expect(soma.negocios_com_valor).toBe(2);
  });

  it("negócio NÃO ganho não entra na soma, mesmo com valor e dentro da janela", () => {
    const soma = somarValorRealizado({
      negocios: [
        negocio({ status: "won", value_cents: 100_000 }),
        negocio({ status: "lost", value_cents: 900_000 }),
        negocio({ status: "open", value_cents: 900_000 }),
      ],
      janela: JANELA,
      moeda: "BRL",
    });
    expect(soma.centavos).toBe(100_000);
    expect(soma.negocios_com_valor).toBe(1);
  });

  it("valor nulo ou zero não vira venda de R$ 0 fantasma", () => {
    const soma = somarValorRealizado({
      negocios: [
        negocio({ value_cents: null }),
        negocio({ value_cents: 0 }),
        negocio({ value_cents: 250_000 }),
      ],
      janela: JANELA,
      moeda: "BRL",
    });
    expect(soma.centavos).toBe(250_000);
    // O card sem preço é contado como IGNORADO, não como venda medida.
    expect(soma.negocios_com_valor).toBe(1);
    expect(soma.ignorados_sem_valor).toBe(2);
  });

  it("moeda diferente da organização não é convertida por câmbio inventado", () => {
    const soma = somarValorRealizado({
      negocios: [
        negocio({ currency: "USD", value_cents: 100_000 }),
        negocio({ currency: "BRL", value_cents: 200_000 }),
        negocio({ currency: null, value_cents: 30_000 }),
      ],
      janela: JANELA,
      moeda: "BRL",
    });
    expect(soma.centavos).toBe(230_000);
    expect(soma.ignorados_outra_moeda).toBe(1);
  });

  it("recorta por funil e por vendedor quando a meta é deles", () => {
    const negocios = [
      negocio({ pipeline_id: "f1", owner_user_id: "u1", value_cents: 100_000 }),
      negocio({ pipeline_id: "f2", owner_user_id: "u1", value_cents: 200_000 }),
      negocio({ pipeline_id: "f1", owner_user_id: "u2", value_cents: 400_000 }),
    ];
    expect(
      somarValorRealizado({ negocios, janela: JANELA, moeda: "BRL", pipelineId: "f1" }).centavos,
    ).toBe(500_000);
    expect(
      somarValorRealizado({ negocios, janela: JANELA, moeda: "BRL", vendedorId: "u1" }).centavos,
    ).toBe(300_000);
    expect(
      somarValorRealizado({
        negocios,
        janela: JANELA,
        moeda: "BRL",
        pipelineId: "f1",
        vendedorId: "u1",
      }).centavos,
    ).toBe(100_000);
  });
});

describe("projetarFimDaJanela", () => {
  it("projeta pelo ritmo decorrido da janela", () => {
    // Metade de setembro decorrida (15 dias de 30) e R$ 1.000 realizados.
    const projecao = projetarFimDaJanela({
      realizado: 100_000,
      janela: JANELA,
      agora: new Date("2026-09-16T00:00:00.000Z"),
    });
    expect(projecao).toBe(200_000);
  });

  it("não projeta janela que já terminou nem a que ainda não começou", () => {
    expect(
      projetarFimDaJanela({
        realizado: 100_000,
        janela: JANELA,
        agora: new Date("2026-10-02T00:00:00.000Z"),
      }),
    ).toBeNull();
    expect(
      projetarFimDaJanela({
        realizado: 100_000,
        janela: JANELA,
        agora: new Date("2026-08-20T00:00:00.000Z"),
      }),
    ).toBeNull();
  });
});

describe("progressoDaMeta", () => {
  it("percentual, falta e atingida valem igual para quantidade e para valor", () => {
    expect(progressoDaMeta({ alvo: 50_000_000, realizado: 12_500_000 })).toEqual({
      percentual: 25,
      falta: 37_500_000,
      atingida: false,
    });
    expect(progressoDaMeta({ alvo: 10, realizado: 12 })).toEqual({
      percentual: 120,
      falta: 0,
      atingida: true,
    });
  });
});

describe("normalizarIndicador", () => {
  it("meta antiga, sem indicador, continua valendo por QUANTIDADE", () => {
    expect(INDICADOR_PADRAO).toBe("vendas_ganhas");
    expect(normalizarIndicador(undefined)).toBe("vendas_ganhas");
    expect(normalizarIndicador(null)).toBe("vendas_ganhas");
    expect(normalizarIndicador("")).toBe("vendas_ganhas");
    expect(normalizarIndicador("outra_coisa")).toBe("vendas_ganhas");
    expect(normalizarIndicador("valor_vendido")).toBe("valor_vendido");
  });
});
