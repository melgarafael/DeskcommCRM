import { beforeEach, describe, expect, it, vi } from "vitest";

// `ai_pricing` com o preço real do gpt-5.6-luna (centavos por milhão de tokens).
const PRECOS = [
  {
    model: "gpt-5.6-luna",
    prompt_cents_per_million_tokens: "20.0000",
    completion_cents_per_million_tokens: "120.0000",
    embedding_cents_per_million_tokens: null,
  },
  {
    // Linha aberta à mão sem taxa nenhuma: não é preço.
    model: "linha-sem-taxa",
    prompt_cents_per_million_tokens: null,
    completion_cents_per_million_tokens: null,
    embedding_cents_per_million_tokens: null,
  },
];

// `ai_models` (o catálogo do cron). 0/0 é o gratuito da OpenRouter; null/null é
// a linha que o catálogo abriu sem preço (`pricing: null`).
const CATALOGO = [
  {
    model_id: "meta-llama/llama-3.3-70b-instruct:free",
    input_price_per_million_cents: 0,
    output_price_per_million_cents: 0,
  },
  {
    model_id: "fornecedor/modelo-sem-preco",
    input_price_per_million_cents: null,
    output_price_per_million_cents: null,
  },
];

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => ({
      select: () =>
        tabela === "ai_models"
          ? {
              in: (_coluna: string, ids: string[]) => ({
                is: () => ({
                  limit: async () => ({
                    data: CATALOGO.filter((l) => ids.includes(l.model_id)),
                    error: null,
                  }),
                }),
              }),
            }
          : { is: async () => ({ data: PRECOS, error: null }) },
    }),
  }),
}));

import { _resetPricingCacheForTests, computeCost } from "@/lib/ai/cost";

describe("computeCost — centavos fracionados", () => {
  beforeEach(() => _resetPricingCacheForTests());

  it("classificador de sentimento custa o que custa, não 1 centavo", async () => {
    // Média medida em llm_calls: 256 tokens de entrada, 41 de saída.
    const cents = await computeCost({ model: "gpt-5.6-luna", promptTokens: 256, completionTokens: 41 });
    expect(cents).toBeCloseTo((256 * 20 + 41 * 120) / 1_000_000, 10);
    expect(cents).toBeLessThan(0.02);
  });

  it("zero tokens é zero, não um centavo", async () => {
    expect(await computeCost({ model: "gpt-5.6-luna", promptTokens: 0, completionTokens: 0 })).toBe(0);
  });

  it("modelo que nenhum catálogo conhece custa null — nunca um 0 que diria \"grátis\" à tela e ao teto", async () => {
    const cents = await computeCost({ model: "modelo-que-ninguem-conhece", promptTokens: 100, completionTokens: 10 });
    expect(cents).toBeNull();
  });

  it("linha de ai_pricing sem taxa nenhuma custa null, não 0", async () => {
    expect(await computeCost({ model: "linha-sem-taxa", promptTokens: 100, completionTokens: 10 })).toBeNull();
  });

  it("modelo gratuito do catálogo (0/0) custa 0 — grátis de verdade não acende o aviso de gasto incompleto", async () => {
    const cents = await computeCost({
      model: "meta-llama/llama-3.3-70b-instruct:free",
      promptTokens: 1000,
      completionTokens: 200,
    });
    expect(cents).toBe(0);
  });

  it("modelo que o catálogo conhece sem preço (null/null) custa null", async () => {
    const cents = await computeCost({ model: "fornecedor/modelo-sem-preco", promptTokens: 1000, completionTokens: 200 });
    expect(cents).toBeNull();
  });
});
