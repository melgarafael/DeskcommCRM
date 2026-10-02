import { beforeEach, describe, expect, it, vi } from "vitest";

// `ai_pricing` com o preço real do gpt-5.6-luna (centavos por milhão de tokens).
const PRECOS = [
  {
    model: "gpt-5.6-luna",
    prompt_cents_per_million_tokens: "20.0000",
    completion_cents_per_million_tokens: "120.0000",
    embedding_cents_per_million_tokens: null,
  },
];

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        is: async () => ({ data: PRECOS, error: null }),
      }),
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
});
