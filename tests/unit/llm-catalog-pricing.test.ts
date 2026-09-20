import { describe, expect, it, vi } from "vitest";
import { catalogCostCents, meteredCostCents } from "@/lib/agent-engine/edge/llm/catalog-pricing";
const usage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 };
const price = { input_price_per_million_cents: "250", output_price_per_million_cents: "1000" };

describe("catalogue accounting", () => {
  it("preserves fractional USD cents instead of rounding every call up", () => {
    expect(catalogCostCents(price, usage)).toBeCloseTo(0.45);
  });
  it("accepts explicitly free rates but never missing or invalid prices", () => {
    expect(
      catalogCostCents(
        { input_price_per_million_cents: 0, output_price_per_million_cents: 0 },
        usage,
      ),
    ).toBe(0);
    for (const value of [null, "", "invalid", "-1", "Infinity"]) {
      expect(
        catalogCostCents({ ...price, input_price_per_million_cents: value }, usage),
      ).toBeNull();
    }
  });
  it("does not invent cache discounts or bill unknown cache prices as ordinary tokens", () => {
    expect(catalogCostCents(price, { ...usage, cacheReadTokens: 20 })).toBeNull();
    expect(catalogCostCents(price, { ...usage, cacheWriteTokens: 20 })).toBeNull();
  });
  it("rejects invalid usage rather than crediting negative consumption", () => {
    expect(catalogCostCents(price, { ...usage, inputTokens: -1 })).toBeNull();
    expect(catalogCostCents(price, { ...usage, outputTokens: Infinity })).toBeNull();
  });
  it("scopes prices by provider and prefers the exact model ID", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [price] });
    expect(
      await meteredCostCents({ query } as never, "openai", "openai/model-a", usage),
    ).toBeCloseTo(0.45);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("provider=$1"), [
      "openai",
      ["openai/model-a", "model-a"],
      "openai/model-a",
    ]);
    expect(query.mock.calls[0]![0]).toContain("when model_id=$3 then 0");
  });
  it("does not apply Anthropic vendor rates to an OpenRouter model", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    expect(
      await meteredCostCents({ query } as never, "openrouter", "anthropic/claude-sonnet-4", usage),
    ).toBeNull();
    expect(query.mock.calls[0]![1]).toEqual([
      "openrouter",
      ["anthropic/claude-sonnet-4"],
      "anthropic/claude-sonnet-4",
    ]);
  });
  it("preserves the existing cache-aware Anthropic computation", async () => {
    const query = vi.fn();
    expect(
      await meteredCostCents({ query } as never, "anthropic", "claude-sonnet-4", {
        ...usage,
        cacheReadTokens: 100,
      }),
    ).toBeCloseTo(0.573);
    expect(query).not.toHaveBeenCalled();
  });
  it("keeps absent pricing or failed lookup explicitly unknown", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error("database down"));
    expect(await meteredCostCents({ query } as never, "openai", "model-a", usage)).toBeNull();
    expect(await meteredCostCents({ query } as never, "openai", "model-a", usage)).toBeNull();
  });
});
