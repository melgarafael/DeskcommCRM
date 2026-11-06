/**
 * O CUSTO QUE A OPENROUTER COBROU, em centavos, pela regra de BYOK.
 *
 * `usage.cost` é o cobrado na conta da OpenRouter; `cost_details.upstream_inference_cost`,
 * o cobrado pelo provedor de origem (doc usage-accounting). O exemplo de Chat
 * Completions da doc traz cost 0,95 e upstream 19 SEM `is_byok`: 0,95 é 5% de 19,
 * a taxa de BYOK. Sem a flag, o max(cost, upstream) não dobra nem grava 5% do gasto.
 */
import { describe, expect, it } from "vitest";

import { custoInformadoPeloOpenRouter } from "./pricing";

const passo = (usage: Record<string, unknown>) => ({ response: { body: { usage } } });
const comUpstream = (cost: unknown, upstream: unknown, isByok?: boolean) => ({
  cost,
  cost_details: { upstream_inference_cost: upstream },
  ...(isByok === undefined ? {} : { is_byok: isByok }),
});

describe("custoInformadoPeloOpenRouter", () => {
  it("⭐ soma o custo de cada passo do laço", () => {
    expect(
      custoInformadoPeloOpenRouter({ steps: [passo({ cost: 0.0123 }), passo({ cost: 0.0007 })] }),
    ).toBeCloseTo(1.3, 9);
  });

  it("is_byok true: a taxa da OpenRouter mais a conta da chave própria", () => {
    expect(custoInformadoPeloOpenRouter({ steps: [passo(comUpstream(0.0005, 0.01, true))] })).toBeCloseTo(1.05, 9);
  });

  it("is_byok false: só o cost — o upstream já está dentro dele, somar dobraria", () => {
    expect(custoInformadoPeloOpenRouter({ steps: [passo(comUpstream(0.95, 19, false))] })).toBeCloseTo(95, 9);
  });

  it("sem is_byok: o max — o exemplo da doc (0,95 de taxa sobre 19) grava 19, não 0,95", () => {
    expect(custoInformadoPeloOpenRouter({ steps: [passo(comUpstream(0.95, 19))] })).toBeCloseTo(1900, 9);
  });

  it("sem is_byok, BYOK dentro da franquia (taxa zero): grava o gasto real, não 0", () => {
    expect(custoInformadoPeloOpenRouter({ steps: [passo(comUpstream(0, 0.5))] })).toBeCloseTo(50, 9);
  });

  it("upstream nulo vale zero", () => {
    expect(custoInformadoPeloOpenRouter({ steps: [passo(comUpstream(0.0123, null))] })).toBeCloseTo(1.23, 9);
  });

  it("cost ausente, NaN ou em texto: undefined — o seam volta à tabela", () => {
    expect(custoInformadoPeloOpenRouter({ steps: [passo({ prompt_tokens: 10 })] })).toBeUndefined();
    expect(custoInformadoPeloOpenRouter({ steps: [passo({ cost: Number.NaN })] })).toBeUndefined();
    expect(custoInformadoPeloOpenRouter({ steps: [passo({ cost: "0.1" })] })).toBeUndefined();
    // Um passo sem o número derruba a soma inteira: número pela metade seria pior que a tabela.
    expect(custoInformadoPeloOpenRouter({ steps: [passo({ cost: 0.01 }), passo({})] })).toBeUndefined();
    expect(custoInformadoPeloOpenRouter({ steps: [{ response: {} }] })).toBeUndefined();
  });

  it("custo negativo é recusado (volta à tabela); fora do BYOK, upstream negativo conta 0", () => {
    // Um número negativo abateria o gasto do mês e furaria o teto e a cota do plano.
    expect(custoInformadoPeloOpenRouter({ steps: [passo({ cost: -0.5 })] })).toBeUndefined();
    expect(custoInformadoPeloOpenRouter({ steps: [passo({ cost: 0.01 }), passo({ cost: -0.01 })] })).toBeUndefined();
    expect(custoInformadoPeloOpenRouter({ steps: [passo(comUpstream(0.01, -5))] })).toBeCloseTo(1, 9);
    expect(custoInformadoPeloOpenRouter({ steps: [passo(comUpstream(0.01, -5, false))] })).toBeCloseTo(1, 9);
  });

  it("BYOK sem upstream legível volta à tabela: o cost sozinho é só a taxa (0 na franquia)", () => {
    expect(custoInformadoPeloOpenRouter({ steps: [passo(comUpstream(0, null, true))] })).toBeUndefined();
    expect(custoInformadoPeloOpenRouter({ steps: [passo(comUpstream(0.01, -5, true))] })).toBeUndefined();
    expect(custoInformadoPeloOpenRouter({ steps: [passo({ cost: 0, is_byok: true })] })).toBeUndefined();
    // Um passo assim derruba a soma inteira, como o passo sem cost.
    expect(
      custoInformadoPeloOpenRouter({ steps: [passo({ cost: 0.01 }), passo(comUpstream(0, undefined, true))] }),
    ).toBeUndefined();
    // Upstream 0 é número legível (modelo grátis na chave própria): vale.
    expect(custoInformadoPeloOpenRouter({ steps: [passo(comUpstream(0, 0, true))] })).toBe(0);
  });

  it("sem passos, lê o corpo do resultado; corpo em texto JSON também é lido", () => {
    expect(custoInformadoPeloOpenRouter({ response: { body: { usage: { cost: 0.02 } } } })).toBeCloseTo(2, 9);
    expect(
      custoInformadoPeloOpenRouter({ steps: [{ response: { body: JSON.stringify({ usage: { cost: 0.03 } }) } }] }),
    ).toBeCloseTo(3, 9);
    expect(custoInformadoPeloOpenRouter({ steps: [{ response: { body: "não é json" } }] })).toBeUndefined();
  });
});
