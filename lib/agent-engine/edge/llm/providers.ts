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

import { CODEX_INFERENCE_BASE_URL } from '@/lib/ai/codex/constantes';
import { criarModeloCodex } from '@/lib/ai/codex/modelo-responses';
import { allowlistedFetch, buildAllowlist } from '../egress';

/** Re-export para o runtime de ensaio (`lib/ai/runtime/agent.ts`) — fonte única do endpoint. */
export { CODEX_INFERENCE_BASE_URL };

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
  (apiKey: string, modelId: string, baseUrl?: string, accountId?: string) => LanguageModel
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
 * Cabeçalhos OPCIONAIS de atribuição da OpenRouter.
 *
 * A doc deles chama `HTTP-Referer` e `X-Title` de "optional headers to identify
 * your app and make it discoverable to users on our site" — servem para
 * atribuição e para o ranking público do site deles, NÃO para a chamada
 * funcionar. Chamada sem eles é atendida normalmente.
 *
 * Por isso eles saem da INSTALAÇÃO e nunca do código: uma URL literal aqui
 * viajaria dentro da imagem que todo self-hoster roda, creditando o consumo de
 * OpenRouter de cada cliente a um site que não é dele. E um título literal com
 * o nome do produto é a marca vazando por fora do resolvedor — a catraca de
 * `tests/unit/branding.test.ts` reprova, e está certa.
 *
 * Sem valor, nenhum header vai: falha aberta na informação, porque a ausência
 * de atribuição não quebra ninguém.
 */
export function cabecalhosDeAtribuicaoOpenRouter(): Record<string, string> | undefined {
  const url = process.env.OPENROUTER_APP_URL?.trim();
  const titulo = process.env.OPENROUTER_APP_TITLE?.trim();
  const headers: Record<string, string> = {};
  if (url) headers['HTTP-Referer'] = url;
  if (titulo) headers['X-Title'] = titulo;
  return Object.keys(headers).length > 0 ? headers : undefined;
}

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
      return createOpenAI({
        apiKey,
        baseURL: endpoint,
        headers: cabecalhosDeAtribuicaoOpenRouter(),
        fetch: contain(endpoint),
      })(modelId);
    },
    /**
     * Assinatura ChatGPT via OAuth (provider `openai-codex`). O primeiro
     * parâmetro AQUI é o access token de curta duração (renovado a cada turno
     * pelo resolver), nunca uma API key `sk-...` — e o endpoint é o backend
     * do Codex (`chatgpt.com`), nunca `api.openai.com`. A allowlist do egress
     * é a DELE, como nos demais canônicos.
     *
     * Transporte Responses NATIVO (`lib/ai/codex/modelo-responses.ts`), não
     * chat-completions: o `.responses()` do `@ai-sdk/openai` v4 é BATCH
     * (não entra em `generateText`) e o backend REJEITA `temperature`/
     * `max_tokens`. O `accountId` (4º argumento) monta o envelope de
     * identidade — sem ele a chamada cai.
     */
    'openai-codex': (accessToken, modelId, _baseUrl, accountId) =>
      criarModeloCodex({
        accessToken,
        accountId,
        modelId,
        fetchImpl: (input, init) => contain(CODEX_INFERENCE_BASE_URL)(input, init),
      }),
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
