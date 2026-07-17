/**
 * Registro de providers da camada agnóstica (F2-23). ÚNICO lugar (junto do resto
 * de edge/llm/) onde SDK de vendor é importado — scripts/lint-llm-imports.ts
 * reprova import fora daqui. Instância POR CHAMADA com a chave BYOK da org
 * (stack.md §2): sem pool global de chave, sem fallback silencioso.
 */
import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModel } from 'ai';

import { allowlistedFetch, buildAllowlist } from '../egress';

/** provider name → (chave BYOK da org, id do modelo) → modelo pronto para generateText. */
export type ProviderRegistry = Record<string, (apiKey: string, modelId: string) => LanguageModel>;

/**
 * Endpoint canônico do provider Anthropic (baseURL default do @ai-sdk/anthropic). NÃO é
 * um knob de política (a allowlist de política é a do egress.ts) — é o destino INTRÍNSECO
 * de ter escolhido o provider anthropic. Se uma org precisar de proxy/baseURL custom, é aqui
 * que ele entra (junto do `fetch` contido), nunca espalhado.
 */
const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com';

/**
 * Providers reais do lançamento. Sonnet (Anthropic) é o default RECOMENDADO —
 * recomendação vive em .env.example/docs; o id do modelo é sempre config da org.
 *
 * F4-08 ressalva 4: o `fetch` INTERNO do provider (generateText) também roteia pela
 * allowlist (`allowlistedFetch`) — sem isso o egress do SDK escapava da contenção F4-03.
 * A allowlist do provider = seu endpoint canônico + hosts extra de config (`allowedHosts`,
 * ex.: proxy corporativo). Testes usam registry fake (MockLanguageModelV4, sem fetch real);
 * este caminho só é exercitado pelo smoke-llm (rede real → api.anthropic.com allowlistada).
 *
 * ponytail: openai/google/deepseek/ollama (stack.md §2) entram quando a primeira org
 * pedir — cada um é uma linha aqui (endpoint + fetch contido) + dep no package.json.
 */
export function createDefaultRegistry(opts?: { allowedHosts?: string[] }): ProviderRegistry {
  const anthropicAllowlist = buildAllowlist([ANTHROPIC_ENDPOINT, ...(opts?.allowedHosts ?? [])]);
  const containedFetch: typeof fetch = (input, init) => {
    const url = typeof input === 'string' || input instanceof URL ? input : input.url;
    return allowlistedFetch(url, init, { allowlist: anthropicAllowlist });
  };
  return {
    anthropic: (apiKey, modelId) => createAnthropic({ apiKey, fetch: containedFetch })(modelId),
  };
}
