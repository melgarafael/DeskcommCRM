import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A migration 0649 grava `ai_pricing` / `ai_models` em 150/750 agora, para a
 * lista mostrar a tarifa de 2027. Quem soma Uso e orçamento lê
 * `llm_calls.cost_cents`. O sentimento e o respondedor legado gravam esse
 * número via `computeCost`. Antes de 2027-01-01T00:00:00.000Z o `costCents`
 * do motor cobra 75/375. Este arquivo prova que `computeCost` não pode
 * ignorar esse corte só porque a linha do catálogo já é a Standard.
 *
 * O nome que faria o teste falhar: `computeCost` voltar a multiplicar os
 * centavos da linha 150/750 para estes três ids (e o prefixo `provider/`)
 * quando o instante ainda é a promo.
 */

const ANTES_DA_VIRADA = new Date("2026-12-31T23:59:59.999Z");
const VIRADA_2027 = new Date("2027-01-01T00:00:00.000Z");

const FLASH = ["gemini-3.6-flash", "gemini-3.7-flash", "gemini-3.8-flash"] as const;

const AI_PRICING = [
  ...FLASH.map((model) => ({
    model,
    prompt_cents_per_million_tokens: 150,
    completion_cents_per_million_tokens: 750,
    embedding_cents_per_million_tokens: null,
  })),
  {
    model: "gemini-3.5-flash",
    prompt_cents_per_million_tokens: 150,
    completion_cents_per_million_tokens: 111,
    embedding_cents_per_million_tokens: null,
  },
];

const AI_MODELS = FLASH.map((model_id) => ({
  model_id,
  input_price_per_million_cents: 150,
  output_price_per_million_cents: 750,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (table === "ai_models") {
        return {
          select: () => ({
            in: (_col: string, ids: string[]) => ({
              is: () => ({
                limit: async () => ({
                  data: AI_MODELS.filter((row) => ids.includes(row.model_id)),
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      return {
        select: () => ({
          is: async () => ({ data: AI_PRICING, error: null }),
        }),
      };
    },
  }),
}));

import { _resetPricingCacheForTests, computeCost } from "@/lib/ai/cost";

async function centavos(
  model: string,
  tokens: { promptTokens?: number; completionTokens?: number },
  em?: Date,
): Promise<number> {
  return computeCost({ model, ...tokens, ...(em ? { em } : {}) });
}

describe("computeCost — Gemini 3.6/3.7/3.8 Flash respeita a virada do costCents", () => {
  beforeEach(() => {
    _resetPricingCacheForTests();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(FLASH)(
    "%s cobra 75/375 no último ms da promo, com ai_pricing já em 150/750",
    async (model) => {
      expect(await centavos(model, { promptTokens: 1_000_000 }, ANTES_DA_VIRADA)).toBeCloseTo(75, 6);
      expect(await centavos(model, { completionTokens: 1_000_000 }, ANTES_DA_VIRADA)).toBeCloseTo(375, 6);
    },
  );

  it.each(FLASH)("%s cobra 150/750 a partir de 2027-01-01T00:00:00.000Z", async (model) => {
    expect(await centavos(model, { promptTokens: 1_000_000 }, VIRADA_2027)).toBeCloseTo(150, 6);
    expect(await centavos(model, { completionTokens: 1_000_000 }, VIRADA_2027)).toBeCloseTo(750, 6);
  });

  it("o prefixo provider/ e o sufixo de data acompanham o mesmo corte", async () => {
    expect(await centavos("google/gemini-3.8-flash", { promptTokens: 1_000_000 }, ANTES_DA_VIRADA)).toBeCloseTo(
      75,
      6,
    );
    expect(await centavos("google/gemini-3.6-flash", { completionTokens: 1_000_000 }, VIRADA_2027)).toBeCloseTo(
      750,
      6,
    );
    expect(
      await centavos("google/gemini-3.8-flash-20270101", { promptTokens: 1_000_000 }, ANTES_DA_VIRADA),
    ).toBeCloseTo(75, 6);
    expect(await centavos("gemini-3.7-flash-20261231", { completionTokens: 1_000_000 }, VIRADA_2027)).toBeCloseTo(
      750,
      6,
    );
  });

  it("sem instante, o relógio de agora é o mesmo corte (caminho dos workers)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(ANTES_DA_VIRADA);
    expect(await centavos("gemini-3.8-flash", { promptTokens: 1_000_000 })).toBeCloseTo(75, 6);
    vi.setSystemTime(VIRADA_2027);
    _resetPricingCacheForTests();
    expect(await centavos("google/gemini-3.7-flash", { completionTokens: 1_000_000 })).toBeCloseTo(750, 6);
  });

  it("um modelo sem essa virada continua na linha de ai_pricing", async () => {
    expect(await centavos("gemini-3.5-flash", { promptTokens: 1_000_000 }, ANTES_DA_VIRADA)).toBeCloseTo(150, 6);
    expect(await centavos("gemini-3.5-flash", { completionTokens: 1_000_000 }, VIRADA_2027)).toBeCloseTo(111, 6);
  });
});
