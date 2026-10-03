/**
 * Cost computation for ai_agent_runs (S-13.08).
 *
 * Looks up the curated `ai_models` catalog (Spec 10 §2.2) and converts token
 * usage into cents, rounded up. Cached in-memory for 5 min — stale catalog data
 * never crashes.
 *
 * Custo DESCONHECIDO nunca é contado como grátis: quando o modelo não é
 * achado (nem após a normalização do id) — ou o catálogo o conhece mas não tem
 * preço — devolve `null`, e não 0. É o mesmo contrato do seam
 * `lib/agent-engine/edge/llm/pricing.ts` ("modelo fora da tabela → custo NULL,
 * mais honesto que inventar 0") e de `precoDoCatalogo` (`lib/ai/cost.ts`):
 * quem soma no teto coalesce para 0, então modelo sem preço não consome teto,
 * mas quem reporta vê null e não um "de graça" inventado. Falha de preço
 * desconhecido avisa no log uma vez por modelo (não é silenciosa).
 *
 * IMPORTANT: distinct from `lib/ai/cost.ts` which still serves the legacy
 * `ai_pricing` table used by the EPIC-06 RAG worker.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";

interface ModelPricingRow {
  provider: string;
  model_id: string;
  input_price_per_million_cents: number | null;
  output_price_per_million_cents: number | null;
}

const TTL_MS = 5 * 60 * 1000;
let cache: Map<string, ModelPricingRow> | null = null;
let cacheAt = 0;

function key(provider: string, modelId: string): string {
  return `${provider}:${modelId}`;
}

async function loadPricing(): Promise<Map<string, ModelPricingRow>> {
  const now = Date.now();
  if (cache && now - cacheAt < TTL_MS) return cache;
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("ai_models")
    .select("provider, model_id, input_price_per_million_cents, output_price_per_million_cents");
  if (error) {
    return cache ?? new Map();
  }
  const map = new Map<string, ModelPricingRow>();
  for (const row of (data ?? []) as ModelPricingRow[]) {
    map.set(key(row.provider, row.model_id), row);
  }
  cache = map;
  cacheAt = now;
  return map;
}

export interface ComputeCostInput {
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Gera os ids canônicos a tentar contra a tabela, do mais específico para o
 * generalista — o match nunca escolhe um generalista quando o exato existe.
 *
 * O catálogo (`ai_models`) guarda `model_id` como o provedor o nomeia: na
 * Anthropic/OpenAI sem prefixo, num roteador com prefixo `provider/`
 * (`anthropic/claude-haiku-4-5`). O id que chega pode trazer três variações que
 * o catálogo não conhece e que a normalização absorve:
 *
 *  - sufixo de variante do roteador (`:beta`, `:free`) — mas o id CRU, com o
 *    sufixo, é sempre o primeiro candidato: `<m>:free` tem linha própria no
 *    catálogo da OpenRouter, com preço 0, e ela vence a linha paga `<m>`;
 *  - prefixo `provider/` já embutido no `model` (issue #1929);
 *  - a versão grafada com ponto (`claude-haiku-4.5`) em vez do hífen do
 *    catálogo (`claude-haiku-4-5`) — o caso desta issue (#1931).
 */
export function normalizarModeloId(model: string): string[] {
  // `:free`, `:beta`, `:beta:free` — o OpenRouter anexa variantes ao id.
  const comPrefixo = (model.split(":")[0] ?? "").trim();
  const nome = comPrefixo.includes("/")
    ? comPrefixo.slice(comPrefixo.indexOf("/") + 1)
    : comPrefixo;

  const candidatos: string[] = [];
  const ordem = [
    model.trim(), // como veio, com o sufixo — o exato vence
    comPrefixo, // só com o sufixo recortado
    comPrefixo.replace(/\./g, "-"), // grafia do catálogo com hífen
    nome, // recorte do prefixo
    nome.replace(/\./g, "-"), // recorte do prefixo + hífen
  ];
  for (const c of ordem) {
    if (c && c.length > 0 && !candidatos.includes(c)) candidatos.push(c);
  }
  return candidatos;
}

function acharLinha(
  pricing: Map<string, ModelPricingRow>,
  input: ComputeCostInput,
): ModelPricingRow | undefined {
  const candidatos = normalizarModeloId(input.model);

  // 0) Variante gratuita (`<m>:free`) só casa a PRÓPRIA linha. Recortar o
  //    sufixo herdaria o preço do `<m>` pago — e o fallback do passo 2, que
  //    procura em qualquer provider, também. Sem linha própria, o preço é
  //    desconhecido: null, nem o do pago nem um 0 inventado.
  if (input.model.split(":").slice(1).includes("free")) {
    return pricing.get(key(input.provider, candidatos[0] ?? ""));
  }

  // 1) id exato sob o provider do chamador.
  for (const c of candidatos) {
    const achado = pricing.get(key(input.provider, c));
    if (achado) return achado;
  }

  // 2) Fallback pelo id, independente do provider: o mesmo
  //    `anthropic/claude-haiku-4-5` servido pela OpenRouter e pela Requesty
  //    divide o preço — sem este passo o match fica à mercê do nome do
  //    provider que o catálogo guardou. O alvo é o candidato menos específico
  //    (nome bare com hífen).
  const alvo = candidatos[candidatos.length - 1];
  for (const linha of pricing.values()) {
    const base = linha.model_id.includes("/")
      ? linha.model_id.slice(linha.model_id.indexOf("/") + 1)
      : linha.model_id;
    if (base.replace(/\./g, "-") === alvo) return linha;
  }
  return undefined;
}

const modelosSemPrecoAvisados = new Set<string>();

/** Avisa UMA vez por (provider, modelo) — a falha não pode ser silenciosa. */
function avisarSemPreco(provider: string, modelo: string): void {
  const chave = `${provider}:${modelo}`;
  if (modelosSemPrecoAvisados.has(chave)) return;
  modelosSemPrecoAvisados.add(chave);
  logger.warn("custo_de_ia_modelo_sem_preco", { provider, modelo });
}

/**
 * Returns cost in cents (rounded up), or `null` when the model has no known
 * price — nunca 0. Unknown é diferente de free: inventar 0 faria um modelo
 * caro entrar no teto como gratuito (defeito do #1880, agora calado em null).
 */
export async function computeCostCents(input: ComputeCostInput): Promise<number | null> {
  const pricing = await loadPricing();
  const row = acharLinha(pricing, input);
  if (!row) {
    avisarSemPreco(input.provider, input.model);
    return null;
  }
  // Catálogo que conhece o modelo mas não tem preço (as duas taxas null, ex.
  // linha aberta pela OpenRouter com `pricing: null`) não é melhor que
  // ausência: null. Já 0/0 é grátis DE VERDADE — `precoParaCentavosPorMilhao`
  // (lib/ai/catalogo/openrouter.ts) grava 0 de propósito para os gratuitos.
  if (row.input_price_per_million_cents == null && row.output_price_per_million_cents == null) {
    avisarSemPreco(input.provider, row.model_id);
    return null;
  }
  const inputRate = Number(row.input_price_per_million_cents ?? 0);
  const outputRate = Number(row.output_price_per_million_cents ?? 0);
  const cents =
    ((input.inputTokens ?? 0) * inputRate) / 1_000_000 +
    ((input.outputTokens ?? 0) * outputRate) / 1_000_000;
  return Math.ceil(cents);
}

/** Test-only: drop the in-memory pricing cache. */
export function _resetRuntimeCostCacheForTests(): void {
  cache = null;
  cacheAt = 0;
}