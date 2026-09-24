/**
 * Cost computation for AI invocations.
 *
 * Looks up `ai_pricing` (rarely changing global table) and converts token
 * usage to cost in *cents* (rounded up to integer to err on the side of
 * over-billing rather than free usage).
 */

import { createAdminClient } from "@/lib/supabase/admin";

interface PricingRow {
  model: string;
  prompt_cents_per_million_tokens: string | number | null;
  completion_cents_per_million_tokens: string | number | null;
  embedding_cents_per_million_tokens: string | number | null;
}

let _pricingCache: Map<string, PricingRow> | null = null;
let _pricingFetchedAt = 0;
const PRICING_TTL_MS = 5 * 60 * 1000; // 5 minutes — enough for hot reload + cheap if missed.

async function loadPricing(): Promise<Map<string, PricingRow>> {
  const now = Date.now();
  if (_pricingCache && now - _pricingFetchedAt < PRICING_TTL_MS) {
    return _pricingCache;
  }
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("ai_pricing")
    .select(
      "model, prompt_cents_per_million_tokens, completion_cents_per_million_tokens, embedding_cents_per_million_tokens",
    )
    .is("superseded_at", null);

  if (error) {
    // Surface but don't crash — cost will be null (unknown) and the row stays auditable.
    return _pricingCache ?? new Map();
  }

  const map = new Map<string, PricingRow>();
  for (const row of (data ?? []) as PricingRow[]) {
    map.set(row.model, row);
  }
  _pricingCache = map;
  _pricingFetchedAt = now;
  return map;
}

function toNumber(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export interface ComputeCostInput {
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  /** For embedding-only models, treat tokens as embedding tokens. */
  embeddingTokens?: number;
}

/**
 * Preço do catálogo (`ai_models`), a tabela que o cron `sync-model-catalog`
 * mantém e a ÚNICA onde chega preço de modelo da OpenRouter.
 *
 * `ai_pricing` é uma lista curta e escrita à mão, com os ids SEM prefixo de
 * provider. Os workers consultam com prefixo (`anthropic/claude-…`,
 * `meta-llama/llama-3.3-70b-instruct`), então o `get` exato errava sempre e o
 * custo ia 0 para `bot_respond` e para todo modelo OpenRouter — a tela de Uso
 * e a de Execuções mostrando R$ 0,00 com o dinheiro saindo, que é literalmente
 * o sintoma citado pela 0130 como motivo da unificação.
 */
async function precoDoCatalogo(
  modelo: string,
): Promise<{ prompt: number; completion: number } | null> {
  const admin = createAdminClient();
  // Duas formas do mesmo id: como veio, e sem o prefixo de provider. O catálogo
  // guarda `model_id` como o provedor o nomeia — com prefixo na OpenRouter, sem
  // ele na Anthropic/OpenAI.
  const semPrefixo = modelo.includes("/") ? modelo.slice(modelo.indexOf("/") + 1) : modelo;
  const { data } = await admin
    .from("ai_models")
    .select("model_id, input_price_per_million_cents, output_price_per_million_cents")
    .in("model_id", [modelo, semPrefixo])
    .is("deprecated_at", null)
    .limit(2);

  const linhas = (data ?? []) as Array<{
    model_id: string;
    input_price_per_million_cents: number | null;
    output_price_per_million_cents: number | null;
  }>;
  // Preferir a correspondência EXATA: `llama-3.3-70b-instruct` pode existir em
  // mais de um provedor com preços diferentes, e o id completo é quem desempata.
  const linha = linhas.find((l) => l.model_id === modelo) ?? linhas[0];
  if (!linha) return null;
  const prompt = toNumber(linha.input_price_per_million_cents);
  const completion = toNumber(linha.output_price_per_million_cents);
  // Catálogo que conhece o modelo mas não tem preço não é melhor que ausência:
  // devolver 0 aqui seria inventar "de graça".
  if (prompt === 0 && completion === 0) return null;
  return { prompt, completion };
}

/**
 * Returns cost in **cents**, rounded up.
 *
 * Returns `null` when pricing is unknown (model not in `ai_pricing` and not in
 * the `ai_models` catalog, or catalog knows the model but has no price).
 * `null` = "don't know" — never invent 0 ("free"). Callers that need a number
 * for display must render unknown as unknown, not $0.
 */
export async function computeCost(input: ComputeCostInput): Promise<number | null> {
  const pricing = await loadPricing();
  const row = pricing.get(input.model);
  if (!row) {
    // `ai_pricing` não conhece: tenta o catálogo, que é onde o cron grava e
    // onde a OpenRouter chega. Embedding não passa por aqui — o catálogo não
    // guarda preço de embedding —, e nesse caso o desfecho é o mesmo de antes:
    // desconhecido, não zero.
    const doCatalogo = await precoDoCatalogo(input.model);
    if (!doCatalogo) return null;
    const cents =
      ((input.promptTokens ?? 0) * doCatalogo.prompt) / 1_000_000 +
      ((input.completionTokens ?? 0) * doCatalogo.completion) / 1_000_000;
    return Math.ceil(cents);
  }

  const promptRate = toNumber(row.prompt_cents_per_million_tokens);
  const completionRate = toNumber(row.completion_cents_per_million_tokens);
  const embeddingRate = toNumber(row.embedding_cents_per_million_tokens);

  const promptTokens = input.promptTokens ?? 0;
  const completionTokens = input.completionTokens ?? 0;
  const embeddingTokens = input.embeddingTokens ?? 0;

  const cents =
    (promptTokens * promptRate) / 1_000_000 +
    (completionTokens * completionRate) / 1_000_000 +
    (embeddingTokens * embeddingRate) / 1_000_000;

  return Math.ceil(cents);
}

/** Test-only: drop the in-memory pricing cache. */
export function _resetPricingCacheForTests(): void {
  _pricingCache = null;
  _pricingFetchedAt = 0;
}
