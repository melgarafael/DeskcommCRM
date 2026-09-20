import { expect, it } from "vitest";
import { costCents } from "@/lib/agent-engine/edge/llm/pricing";
const usage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 };
it.each([
  "claude-opus-4-5",
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-opus-5",
])("uses the version-specific tariff for %s", (model) => {
  expect(costCents(model, usage)).toBe(1);
});
it("preserves the original Opus and accepts vendor dated snapshots", () => {
  expect(costCents("claude-opus-4", usage)).toBe(3);
  expect(costCents("claude-opus-4-1", usage)).toBe(3);
  expect(costCents("claude-opus-4-5-20251101", usage)).toBe(1);
});
it.each([
  "claude-opus-4-99",
  "claude-opus-4-experimental",
  "claude-haiku-4",
  "claude-sonnet-4-custom",
])("does not inherit a guessed tariff for %s", (model) => {
  expect(costCents(model, usage)).toBeNull();
});
it("distinguishes five-minute and one-hour cache writes", () => {
  const cached = { ...usage, cacheReadTokens: 200, cacheWriteTokens: 400 };
  expect(costCents("claude-sonnet-4-6", cached, "5m")).toBeCloseTo(0.576);
  expect(costCents("claude-sonnet-4-6", cached, "1h")).toBeCloseTo(0.666);
  expect(costCents("claude-sonnet-4-6", cached)).toBeNull();
});
it("rejects invalid token accounting and overflow", () => {
  expect(costCents("claude-opus-4", { ...usage, cacheReadTokens: 1001 })).toBeNull();
  expect(costCents("claude-opus-4", { ...usage, inputTokens: Infinity })).toBeNull();
  expect(costCents("claude-opus-4", { ...usage, inputTokens: Number.MAX_VALUE })).toBeNull();
});
