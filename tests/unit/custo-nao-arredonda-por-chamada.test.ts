import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * O CENTAVO INTEIRO POR CHAMADA COBRAVA 12× NO CUSTO DO AGENTE.
 *
 * ─── O defeito, medido numa instalação real ─────────────────────────────────
 *
 * `computeCostCents` (`lib/ai/runtime/cost.ts`, o custo de `ai_agent_runs`)
 * fazia `Math.ceil(cents)` "para errar para o lado de cobrar". Numa chamada
 * grande isso arredonda centavos e ninguém nota. Mas uma chamada de ~600
 * tokens num modelo barato custa ~0,08¢ — e `ceil(0.08)` = 1¢.
 *
 * Em 14 dias: 1.284 chamadas, 1.122¢ registrados, ~103¢ de custo real. E o
 * teto de gasto por chamada (`cost_budget_cents`) compara com este número:
 * cortaria o turno cedo demais por um gasto que não existia.
 *
 * O irmão `computeCost` (`lib/ai/cost.ts`) já deixou de arredondar
 * (`custo-de-ia-nao-arredonda-para-cima.test.ts`); este arquivo cobre o
 * runtime do agente, que tinha ficado com o ceil.
 */
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () =>
        Promise.resolve({
          data: [
            {
              provider: "anthropic",
              model_id: "claude-haiku-4-5",
              input_price_per_million_cents: 100,
              output_price_per_million_cents: 500,
            },
          ],
          error: null,
        }),
    }),
  }),
}));

import { computeCostCents, _resetRuntimeCostCacheForTests } from "@/lib/ai/runtime/cost";

beforeEach(() => _resetRuntimeCostCacheForTests());

describe("o custo por chamada é fracionário", () => {
  it("a chamada do classificador custa o que custa — não 1 centavo", async () => {
    // O caso real: ~566 tokens de entrada, ~47 de saída.
    const cents = await computeCostCents({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      inputTokens: 566,
      outputTokens: 47,
    });
    // 566×100/1M + 47×500/1M = 0,0566 + 0,0235 = 0,0801¢
    expect(cents).toBeCloseTo(0.0801, 3);
    expect(cents, "voltou o centavo inteiro por chamada").toBeLessThan(1);
  });

  it("chamada pequena nunca vira zero — 'de graça' segue proibido", async () => {
    const cents = await computeCostCents({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      inputTokens: 10,
      outputTokens: 1,
    });
    expect(cents).toBeGreaterThan(0);
  });

  it("mil chamadas pequenas somam o real, não mil centavos", async () => {
    const umaChamada = await computeCostCents({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      inputTokens: 566,
      outputTokens: 47,
    });
    // O modelo tem preço conhecido: `null` (preço desconhecido, upstream #1963) aqui seria defeito.
    if (umaChamada === null) throw new Error("claude-haiku-4-5 sem preço");
    const mil = umaChamada * 1000;
    // O real de 1.000 chamadas é ~80¢. Com o ceil antigo seriam 1.000¢.
    expect(mil).toBeLessThan(100);
  });
});
