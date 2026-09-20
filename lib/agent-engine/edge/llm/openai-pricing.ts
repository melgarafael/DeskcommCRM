import type { TokenUsage } from "./pricing";

// First-party global endpoint only. USD per million tokens, verified 2026-09-20:
// https://developers.openai.com/api/docs/pricing
// Model pages define >272k input tokens as long context for the whole request.
const RATES = new Map([
  ["gpt-6-astra", { input: 10, output: 50 }],
  ["gpt-5.6-sol", { input: 4, output: 20 }],
  ["gpt-5.6-terra", { input: 2, output: 12 }],
  ["gpt-5.6-luna", { input: 0.2, output: 1.2 }],
]);

export function hasOpenAiTariff(model: string): boolean {
  return RATES.has(model);
}

/** Price one provider request, never the sum of multiple tool steps. */
export function openAiCostCents(
  model: string,
  usage: TokenUsage,
  serviceTier?: string,
): number | null {
  const price = RATES.get(model);
  if (!price) return null;
  // Read the tier actually returned by the provider. "auto" is a request policy,
  // not evidence of which service ran; missing/unknown tiers stay unresolved.
  const tier =
    serviceTier === "default"
      ? 1
      : serviceTier === "flex"
        ? 0.5
        : serviceTier === "fast" || serviceTier === "priority"
          ? 2
          : null;
  if (tier === null) return null;
  if (Object.values(usage).some((value) => !Number.isFinite(value) || value < 0)) return null;
  if (usage.cacheReadTokens + usage.cacheWriteTokens > usage.inputTokens) return null;
  const long = usage.inputTokens > 272_000;
  const ordinary = usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens;
  const input =
    (ordinary + usage.cacheReadTokens * 0.1 + usage.cacheWriteTokens * 1.25) *
    price.input *
    (long ? 2 : 1);
  const output = usage.outputTokens * price.output * (long ? 1.5 : 1);
  const cost = ((input + output) * tier) / 10_000;
  return Number.isFinite(cost) ? cost : null;
}
