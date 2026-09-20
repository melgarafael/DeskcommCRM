import type pg from "pg";
import { costCents, type TokenUsage } from "./pricing";

/** Catalogue rates are fractional USD cents per million tokens, never BRL. */
export interface CatalogTokenPrice {
  input_price_per_million_cents: number | string | null;
  output_price_per_million_cents: number | string | null;
}

function rate(value: number | string | null): number | null {
  if (value === null || (typeof value === "string" && !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function catalogCostCents(price: CatalogTokenPrice, usage: TokenUsage): number | null {
  if (Object.values(usage).some((value) => !Number.isFinite(value) || value < 0)) return null;
  // This catalogue has no cache read/write tariffs. Preserve unknown instead
  // of billing cached input at an invented price or calling it free.
  if (usage.cacheReadTokens > 0 || usage.cacheWriteTokens > 0) return null;
  const input = rate(price.input_price_per_million_cents);
  const output = rate(price.output_price_per_million_cents);
  if (input === null || output === null) return null;
  const cost = (usage.inputTokens * input + usage.outputTokens * output) / 1_000_000;
  return Number.isFinite(cost) ? cost : null;
}

/** The chosen provider is mandatory: identical model IDs can have different prices. */
export async function meteredCostCents(
  db: Pick<pg.PoolClient, "query">,
  provider: string,
  model: string,
  usage: TokenUsage,
  cacheWriteTtl?: "5m" | "1h",
): Promise<number | null> {
  if (Object.values(usage).some((value) => !Number.isFinite(value) || value < 0)) return null;
  if (usage.cacheReadTokens + usage.cacheWriteTokens > usage.inputTokens) return null;
  const canonical = model.startsWith(`${provider}/`) ? model.slice(provider.length + 1) : model;
  // Apply first-party tariffs only to their actual provider.
  if (provider === "anthropic") {
    const legacy = costCents(canonical, usage, cacheWriteTtl);
    if (legacy !== null) return legacy;
  }
  try {
    const { rows } = await db.query<CatalogTokenPrice>(
      `select input_price_per_million_cents, output_price_per_million_cents
       from ai_models where provider=$1 and model_id=any($2::text[])
       order by case when model_id=$3 then 0 else 1 end limit 1`,
      [provider, [...new Set([model, canonical])], model],
    );
    return rows[0] ? catalogCostCents(rows[0], usage) : null;
  } catch {
    // Accounting must not discard an already generated answer or fabricate zero.
    return null;
  }
}
