/**
 * Registro de providers da camada agnóstica. ÚNICO lugar (junto do resto de
 * edge/llm/) onde SDK de vendor é importado. Instância POR CHAMADA com a chave
 * BYOK da org: sem pool global de chave, sem fallback silencioso.
 */
import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModel } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';

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
 * O `fetch` INTERNO do provider (generateText) também roteia pela allowlist
 * (`allowlistedFetch`) — sem isso o egress do SDK escapava da contenção. A
 * allowlist do provider = seu endpoint canônico + hosts extra de config
 * (`allowedHosts`, ex.: proxy corporativo). Testes usam o registry fake
 * (createFakeRegistry, sem fetch real); este caminho só é exercitado pelo smoke
 * (rede real → api.anthropic.com allowlistada).
 *
 * ponytail: openai/google entram quando a primeira org pedir — cada um é uma
 * linha aqui (endpoint + fetch contido) + dep já instalada no repo.
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

/**
 * Registry FAKE para testes: provider 'anthropic' (e alias 'fake') respondendo
 * com o MockLanguageModelV3 do SDK v6 instalado — zero rede, zero chave real.
 * O doGenerate default devolve `text` com usage fixo; injete o seu para cenários
 * de tool-call/erro.
 */
type MockDoGenerate = NonNullable<ConstructorParameters<typeof MockLanguageModelV3>[0]>['doGenerate'];

export function createFakeRegistry(
  doGenerate?: MockDoGenerate,
  opts?: { text?: string },
): ProviderRegistry {
  const factory = (_apiKey: string, modelId: string): LanguageModel =>
    new MockLanguageModelV3({
      modelId,
      doGenerate:
        doGenerate ??
        {
          content: [{ type: 'text', text: opts?.text ?? 'ok' }],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
          warnings: [],
        },
    });
  return { anthropic: factory, fake: factory };
}
