/**
 * Standard first-party Anthropic prices in USD per million tokens.
 * Source: https://platform.claude.com/docs/en/about-claude/pricing
 * Verified 2026-09-20. Exact versions (and dated snapshots) only: a new
 * model must never silently inherit a differently priced family's tariff.
 * Cache-write duration is supplied by the caller; absent means unknown.
 */
const USD_PER_MTOK: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4": { input: 3, output: 15 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-opus-4": { input: 15, output: 75 },
  "claude-opus-4-1": { input: 15, output: 75 },
  "claude-opus-4-5": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-5": { input: 5, output: 25 },
};

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * Custo em CENTS (fracionário; coluna numeric) ou null se o modelo não tem preço
 * conhecido. `inputTokens` aqui é o TOTAL do usage do SDK — a parcela cacheada é
 * descontada e cobrada pela tarifa de cache.
 */
export function costCents(
  model: string,
  usage: TokenUsage,
  cacheWriteTtl?: "5m" | "1h",
): number | null {
  const canonical = model.replace(/-\d{8}$/, "");
  const p = USD_PER_MTOK[canonical];
  if (!p) return null;
  if (Object.values(usage).some((value) => !Number.isFinite(value) || value < 0)) return null;
  if (usage.cacheReadTokens + usage.cacheWriteTokens > usage.inputTokens) return null;
  if (usage.cacheWriteTokens > 0 && !cacheWriteTtl) return null;
  const noCacheInput = usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens;
  const cost =
    (noCacheInput * p.input +
      usage.cacheReadTokens * p.input * 0.1 +
      usage.cacheWriteTokens * p.input * (cacheWriteTtl === "5m" ? 1.25 : 2) +
      usage.outputTokens * p.output) /
    10_000;
  return Number.isFinite(cost) ? cost : null;
}
