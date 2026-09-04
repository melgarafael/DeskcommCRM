/**
 * Registro de providers da camada agnóstica. ÚNICO lugar (junto do resto de
 * edge/llm/) onde SDK de vendor é importado. Instância POR CHAMADA com a chave
 * BYOK da org: sem pool global de chave, sem fallback silencioso.
 */
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';

import { allowlistedFetch, buildAllowlist } from '../egress';

/**
 * provider name → (chave BYOK da org, id do modelo, endpoint opcional) → modelo
 * pronto para generateText.
 *
 * O terceiro parâmetro é o endpoint escolhido no painel de provedores
 * (`ai_purpose_bindings.base_url`). Existe por causa dos dois casos que o
 * registry precisa atender e que não têm endpoint fixo: um gateway
 * OpenAI-compatível na frente da OpenRouter e, no roteiro do produto, um modelo
 * rodando na máquina do próprio cliente. É opcional — os providers canônicos
 * ignoram e continuam indo ao endpoint intrínseco de terem sido escolhidos.
 */
export type ProviderRegistry = Record<
  string,
  (apiKey: string, modelId: string, baseUrl?: string) => LanguageModel
>;

/**
 * Endpoint canônico do provider Anthropic (baseURL default do @ai-sdk/anthropic). NÃO é
 * um knob de política (a allowlist de política é a do egress.ts) — é o destino INTRÍNSECO
 * de ter escolhido o provider anthropic. Se uma org precisar de proxy/baseURL custom, é aqui
 * que ele entra (junto do `fetch` contido), nunca espalhado.
 */
const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com';
const OPENAI_ENDPOINT = 'https://api.openai.com';
const GOOGLE_ENDPOINT = 'https://generativelanguage.googleapis.com';
/**
 * A OpenRouter fala a API da OpenAI, então o provider `@ai-sdk/openai` conversa
 * com ela sem dependência nova — e os ids dela já vêm no formato
 * `familia/modelo`, o mesmo dos nossos, sem tradução no meio.
 */
export const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1';
/**
 * Os seis provedores abaixo são todos compatíveis com a API de Chat
 * Completions da OpenAI (mesmo padrão da OpenRouter): `createOpenAI` com
 * `baseURL` apontando pro endpoint canônico de cada um. O `baseUrl` do
 * painel (terceiro argumento da fábrica) ainda vence quando presente — é o
 * que permite proxy/gateway próprio, e é OBRIGATÓRIO para `ollama`, que não
 * tem endpoint hospedado: o cliente aponta pra própria VPS/máquina.
 */
export const NVIDIA_ENDPOINT = 'https://integrate.api.nvidia.com/v1';
/** Sem endpoint hospedado — é só o default sugerido pela tela quando o
 *  operador ainda não digitou o seu. Nunca usado sem `baseUrl` explícito em
 *  produção (a org roda o Ollama na própria rede). */
export const OLLAMA_DEFAULT_ENDPOINT = 'http://localhost:11434/v1';
export const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/v1';
export const QWEN_ENDPOINT = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
export const ZHIPU_ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4';
export const MOONSHOT_ENDPOINT = 'https://api.moonshot.cn/v1';

/**
 * Providers reais do lançamento. Sonnet (Anthropic) é o default RECOMENDADO —
 * recomendação vive em .env.example/docs; o id do modelo é sempre config da org.
 *
 * O `fetch` INTERNO do provider (generateText) também roteia pela allowlist
 * (`allowlistedFetch`) — sem isso o egress do SDK escapava da contenção. A
 * allowlist do provider = seu endpoint canônico + hosts extra de config
 * (`allowedHosts`, ex.: proxy corporativo). Testes usam o registry fake
 * (createFakeRegistry, sem fetch real); este caminho só é exercitado pelo smoke
 * (rede real → endpoint canônico do provider allowlistado).
 */
export function createDefaultRegistry(opts?: { allowedHosts?: string[] }): ProviderRegistry {
  const extra = opts?.allowedHosts ?? [];
  const contain = (endpoint: string): typeof fetch => {
    const allow = buildAllowlist([endpoint, ...extra]);
    return (input, init) => {
      const url = typeof input === 'string' || input instanceof URL ? input : input.url;
      return allowlistedFetch(url, init, { allowlist: allow });
    };
  };
  return {
    anthropic: (apiKey, modelId) =>
      createAnthropic({ apiKey, fetch: contain(ANTHROPIC_ENDPOINT) })(modelId),
    openai: (apiKey, modelId) =>
      createOpenAI({ apiKey, fetch: contain(OPENAI_ENDPOINT) })(modelId),
    google: (apiKey, modelId) =>
      createGoogleGenerativeAI({ apiKey, fetch: contain(GOOGLE_ENDPOINT) })(modelId),
    /**
     * O `baseUrl` do painel é honrado aqui, e a allowlist do egress passa a ser
     * a DELE — não a da OpenRouter mais um furo. Apontar para um gateway
     * próprio é escolha legítima do operador; deixar a allowlist fixa no
     * endpoint canônico faria o egress bloquear a própria configuração que a
     * tela ofereceu, com erro de rede que ninguém liga ao painel.
     */
    openrouter: (apiKey, modelId, baseUrl) => {
      const endpoint = baseUrl ?? OPENROUTER_ENDPOINT;
      return createOpenAI({ apiKey, baseURL: endpoint, fetch: contain(endpoint) })(modelId);
    },
    nvidia: (apiKey, modelId, baseUrl) => {
      const endpoint = baseUrl ?? NVIDIA_ENDPOINT;
      return createOpenAI({ apiKey, baseURL: endpoint, fetch: contain(endpoint) })(modelId);
    },
    /**
     * Sem chave real: `apiKey` vem vazia/dummy do painel (Ollama não cobra e
     * não autentica por padrão). O `baseUrl` é OBRIGATÓRIO na prática — sem
     * ele cai no default `localhost`, que só faz sentido rodando ao lado do
     * próprio processo (dev). `createOpenAI` aceita string vazia sem lançar;
     * quem valida se há endpoint alcançável é `validateOllamaEndpoint`.
     */
    ollama: (apiKey, modelId, baseUrl) => {
      const endpoint = baseUrl ?? OLLAMA_DEFAULT_ENDPOINT;
      return createOpenAI({ apiKey: apiKey || 'ollama', baseURL: endpoint, fetch: contain(endpoint) })(
        modelId,
      );
    },
    deepseek: (apiKey, modelId, baseUrl) => {
      const endpoint = baseUrl ?? DEEPSEEK_ENDPOINT;
      return createOpenAI({ apiKey, baseURL: endpoint, fetch: contain(endpoint) })(modelId);
    },
    qwen: (apiKey, modelId, baseUrl) => {
      const endpoint = baseUrl ?? QWEN_ENDPOINT;
      return createOpenAI({ apiKey, baseURL: endpoint, fetch: contain(endpoint) })(modelId);
    },
    zhipu: (apiKey, modelId, baseUrl) => {
      const endpoint = baseUrl ?? ZHIPU_ENDPOINT;
      return createOpenAI({ apiKey, baseURL: endpoint, fetch: contain(endpoint) })(modelId);
    },
    moonshot: (apiKey, modelId, baseUrl) => {
      const endpoint = baseUrl ?? MOONSHOT_ENDPOINT;
      return createOpenAI({ apiKey, baseURL: endpoint, fetch: contain(endpoint) })(modelId);
    },
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
