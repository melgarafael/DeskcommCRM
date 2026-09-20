import { expect, it, vi } from "vitest";
import { meteredCostCents } from "@/lib/agent-engine/edge/llm/catalog-pricing";

const usage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 400, cacheWriteTokens: 100 };
const db = { query: vi.fn().mockResolvedValue({ rows: [] }) };

it("prices measured OpenAI cache reads and writes at their own rates", async () => {
  expect(
    await meteredCostCents(db as never, "openai", "gpt-5.6-terra", usage, undefined, "default"),
  ).toBeCloseTo(0.373);
});

it("applies the long-context rate to the whole individual request above 272k", async () => {
  const context = { ...usage, inputTokens: 272000, cacheReadTokens: 0, cacheWriteTokens: 0 };
  expect(
    await meteredCostCents(db as never, "openai", "gpt-5.6-terra", context, undefined, "default"),
  ).toBeCloseTo(54.64);
  expect(
    await meteredCostCents(
      db as never,
      "openai",
      "gpt-5.6-terra",
      { ...context, inputTokens: 272001 },
      undefined,
      "default",
    ),
  ).toBeCloseTo(109.1604);
});

it.each(["auto", "ultrafast", "unknown", undefined])(
  "does not guess returned tier %s or fall back to a flat catalog price",
  async (tier) => {
    const query = vi
      .fn()
      .mockResolvedValue({
        rows: [{ input_price_per_million_cents: 200, output_price_per_million_cents: 1200 }],
      });
    expect(
      await meteredCostCents({ query } as never, "openai", "gpt-5.6-terra", usage, undefined, tier),
    ).toBeNull();
    expect(query).not.toHaveBeenCalled();
  },
);

it.each([
  ["default", 1],
  ["flex", 0.5],
  ["fast", 2],
  ["priority", 2],
] as const)("uses actual %s processing", async (tier, factor) => {
  expect(
    await meteredCostCents(db as never, "openai", "openai/gpt-5.6-terra", usage, undefined, tier),
  ).toBeCloseTo(0.373 * factor);
});

it("does not use direct prices for an intermediary or an unverified model version", async () => {
  expect(
    await meteredCostCents(
      db as never,
      "openrouter",
      "openai/gpt-5.6-terra",
      usage,
      undefined,
      "default",
    ),
  ).toBeNull();
  expect(
    await meteredCostCents(db as never, "openai", "gpt-5.6-terra-new", usage, undefined, "default"),
  ).toBeNull();
});

it.each([
  { ...usage, cacheWriteTokens: 900 },
  { ...usage, outputTokens: NaN },
  { ...usage, inputTokens: -1 },
  { ...usage, outputTokens: Number.MAX_VALUE },
])("rejects invalid or overflowing measurements", async (invalid) => {
  expect(
    await meteredCostCents(db as never, "openai", "gpt-5.6-terra", invalid, undefined, "default"),
  ).toBeNull();
});
