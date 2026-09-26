/**
 * A conta do relatório "Perdas" (issue #1537).
 *
 * As duas regras que a issue cobra por teste: agrupar motivo com categoria e
 * NÃO somar moedas diferentes num total só.
 */
import { describe, it, expect } from "vitest";

import { agruparPerdas, type PerdaLinha } from "./perdas";

function linha(parcial: Partial<PerdaLinha>): PerdaLinha {
  return {
    lost_reason: null,
    lost_from_stage_id: null,
    value_cents: null,
    currency: null,
    ...parcial,
  };
}

describe("agruparPerdas (#1537)", () => {
  it("agrupa por motivo e pela categoria resolvida no funil", () => {
    const linhas = [
      linha({ lost_reason: "price", pipeline_id: "f1" }),
      linha({ lost_reason: "price", pipeline_id: "f1" }),
      linha({ lost_reason: "Não tinha o perfil", pipeline_id: "f1" }),
    ];
    const relatorio = agruparPerdas(linhas, {
      settingsPorFunil: {
        f1: { lost_reasons: [{ label: "Não tinha o perfil", categoria: "Mérito" }] },
      },
    });

    expect(relatorio.porMotivo).toEqual([
      { chave: "price", quantidade: 2 },
      { chave: "Não tinha o perfil", quantidade: 1 },
    ]);
    expect(relatorio.porCategoria).toEqual([
      { chave: "Nós", quantidade: 2 },
      { chave: "Mérito", quantidade: 1 },
    ]);
    expect(relatorio.total).toBe(3);
  });

  it("a MESMA categoria pode ser resolvida funil a funil (pipeline_id importa)", () => {
    const linhas = [
      linha({ lost_reason: "Preço", pipeline_id: "f1" }),
      linha({ lost_reason: "Preço", pipeline_id: "f2" }),
    ];
    const relatorio = agruparPerdas(linhas, {
      settingsPorFunil: {
        f1: { lost_reasons: [{ label: "Preço", categoria: "Concorrência" }] },
        f2: { lost_reasons: ["Preço"] },
      },
    });
    // f2 cadastrou "Preço" como TEXTO PURO e não é canônico (`price` é): sem
    // categoria declarada ele fica no balde honesto, sem puxar regra de outro.
    expect(relatorio.porCategoria).toEqual([
      { chave: "Concorrência", quantidade: 1 },
      { chave: "Sem categoria", quantidade: 1 },
    ]);
  });

  it("transferência entre funis não entra no relatório nem no total (0266)", () => {
    const relatorio = agruparPerdas([
      linha({ lost_reason: "moved_to_another_pipeline", value_cents: 500, currency: "BRL" }),
      linha({ lost_reason: "price", value_cents: 100, currency: "BRL" }),
    ]);
    expect(relatorio.total).toBe(1);
    expect(relatorio.porMotivo).toEqual([{ chave: "price", quantidade: 1 }]);
    expect(relatorio.porMoeda).toEqual([{ moeda: "BRL", quantidade: 1, valor_cents: 100 }]);
  });

  it("sem motivo e sem categoria viram rótulos honestos, não some da soma", () => {
    const relatorio = agruparPerdas([linha({})], {});
    expect(relatorio.porMotivo).toEqual([{ chave: "Sem motivo registrado", quantidade: 1 }]);
    expect(relatorio.porCategoria).toEqual([{ chave: "Sem categoria", quantidade: 1 }]);
    expect(relatorio.porEtapa).toEqual([{ chave: "Etapa desconhecida", quantidade: 1 }]);
  });

  it("valor NUNCA mistura moedas: cada balde é o da própria moeda", () => {
    const linhas = [
      linha({ lost_reason: "price", value_cents: 120_00, currency: "BRL" }),
      linha({ lost_reason: "price", value_cents: 90_00, currency: "USD" }),
      linha({ lost_reason: "price", value_cents: 40_00, currency: null }),
      linha({ lost_reason: "price", value_cents: 10_00, currency: "BRL" }),
    ];
    const relatorio = agruparPerdas(linhas, {});

    expect(relatorio.porMoeda).toEqual([
      { moeda: "BRL", quantidade: 2, valor_cents: 130_00 },
      { moeda: "USD", quantidade: 1, valor_cents: 90_00 },
      { moeda: "sem moeda", quantidade: 1, valor_cents: 40_00 },
    ]);
    // Não existe campo "total geral" de valor — a soma das moedas não é número.
    expect(Object.keys(relatorio)).not.toContain("valor_total");
  });

  it("a etapa de saída vira nome quando existe e id quando o nome não veio", () => {
    const relatorio = agruparPerdas(
      [
        linha({ lost_from_stage_id: "s1" }),
        linha({ lost_from_stage_id: "s1" }),
        linha({ lost_from_stage_id: "s2" }),
      ],
      { etapas: { s1: "Proposta enviada" } },
    );
    expect(relatorio.porEtapa).toEqual([
      { chave: "Proposta enviada", quantidade: 2 },
      { chave: "s2", quantidade: 1 },
    ]);
  });

  it("ordena do maior para o menor, com desempate alfabético estável", () => {
    const relatorio = agruparPerdas(
      [linha({ lost_reason: "b" }), linha({ lost_reason: "a" }), linha({ lost_reason: "b" })],
      {},
    );
    expect(relatorio.porMotivo.map((c) => c.chave)).toEqual(["b", "a"]);
  });
});
