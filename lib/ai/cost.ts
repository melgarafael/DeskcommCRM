/**
 * Cost computation for AI invocations.
 *
 * Looks up `ai_pricing` (rarely changing global table) and converts token
 * usage to cost in *cents*, FRACIONADO — igual ao `costCents` do seam
 * (`lib/agent-engine/edge/llm/pricing.ts`) e às colunas `numeric` de
 * `llm_calls`/`ai_invocations`.
 *
 * Exceção: os ids com promoção datada (Gemini 3.6/3.7/3.8 Flash, migration
 * 0649; Gemini 4 Argon, migration 0703 — e o prefixo `provider/`) não usam a
 * linha. Ela já guarda a tarifa POSTERIOR à promo, para a lista mostrá-la. O
 * gasto sai de `costCentsComVirada`, o mesmo corte de `costCents`.
 *
 * Arredondava para cima até o centavo inteiro "para errar cobrando a mais".
 * Numa chamada de classificador (~250 tokens de entrada no gpt-5.6-luna, custo
 * real ≈ 0,01 centavo) isso gravava 1 centavo: 100× o real. Medido numa VPS em
 * set/2026: o `sentiment_classify` somava 5.278 de 5.714 centavos do mês — o
 * teto de orçamento via um gasto que não existiu, e ligado teria travado a IA
 * da organização por um número falso.
 */

import { costCentsComVirada } from "@/lib/agent-engine/edge/llm/pricing";
import { createAdminClient } from "@/lib/supabase/admin";
import { multiplicadorDoDegrau } from "@/lib/ai/custo-escalonado";

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
    // Surface but don't crash — cost will be 0 and the row stays auditable.
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
  /**
   * Instante da chamada. Sem ele, agora. Os ids com promoção datada (e o
   * prefixo `provider/`) usam o corte de `costCents`, não a linha da tabela.
   */
  em?: Date;
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
  // Catálogo que conhece o modelo mas não tem preço (as duas taxas null) não é
  // melhor que ausência: devolver 0 aqui seria inventar "de graça". Já 0/0 é
  // grátis DE VERDADE (`:free` da OpenRouter) — a mesma regra de
  // `computeCostCents` (lib/ai/runtime/cost.ts). Olhar o valor CRU: `toNumber`
  // transforma null em 0 e apagaria a diferença.
  if (linha.input_price_per_million_cents == null && linha.output_price_per_million_cents == null) {
    return null;
  }
  const prompt = toNumber(linha.input_price_per_million_cents);
  const completion = toNumber(linha.output_price_per_million_cents);
  return { prompt, completion };
}

/**
 * Returns cost in **cents** (fracionado, sem arredondar). `null` quando nenhum
 * catálogo conhece o modelo, nunca 0: o 0 ia para `llm_calls` e dizia "grátis" à
 * tela de uso e ao teto, que somam `coalesce(cost_cents, 0)` — com o null o gasto
 * é o mesmo, e o sinal de gasto incompleto acende.
 */
export async function computeCost(input: ComputeCostInput): Promise<number | null> {
  // Degrau do Haiku 5.5 (#4123): acima de 100 mil tokens de ENTRADA a chamada
  // inteira (entrada, saída e cache) custa 5×. A regra mora num lugar só
  // (`lib/ai/custo-escalonado.ts`) e é a MESMA que o runtime nativo aplica em
  // `computeCostCents` — as duas rotas de custo do repo não podem divergir.
  // Aplicada no fim, sobre o centavo fracionado: nenhuma parcela é arredondada.
  const comDegrau = (cents: number) =>
    cents * multiplicadorDoDegrau(input.model, input.promptTokens);

  // Ids com promoção datada guardam no catálogo a tarifa posterior à promo
  // (0649, 0703). O gasto gravado em llm_calls tem de seguir `costCents`
  // (promo estritamente antes do corte). Outro modelo segue a linha de ai_pricing.
  const pelaVirada = costCentsComVirada(
    input.model,
    {
      inputTokens: input.promptTokens ?? 0,
      outputTokens: input.completionTokens ?? 0,
    },
    input.em ?? new Date(),
  );
  if (pelaVirada !== null) return comDegrau(pelaVirada);

  const pricing = await loadPricing();
  const row = pricing.get(input.model);
  if (!row) {
    // `ai_pricing` não conhece: tenta o catálogo, que é onde o cron grava e
    // onde a OpenRouter chega. Embedding não passa por aqui — o catálogo não
    // guarda preço de embedding —, e nesse caso o desfecho é o mesmo de antes.
    const doCatalogo = await precoDoCatalogo(input.model);
    if (!doCatalogo) return null;
    const cents =
      ((input.promptTokens ?? 0) * doCatalogo.prompt) / 1_000_000 +
      ((input.completionTokens ?? 0) * doCatalogo.completion) / 1_000_000;
    return comDegrau(cents);
  }

  // Linha sem taxa nenhuma não é preço: é a mesma ausência do catálogo.
  if (
    row.prompt_cents_per_million_tokens === null &&
    row.completion_cents_per_million_tokens === null &&
    row.embedding_cents_per_million_tokens === null
  ) {
    return null;
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

  return comDegrau(cents);
}

/** Test-only: drop the in-memory pricing cache. */
export function _resetPricingCacheForTests(): void {
  _pricingCache = null;
  _pricingFetchedAt = 0;
}
