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
export const OPENROUTER_ENDPOINT = process.env.OPENROUTER_BASE_URL?.trim() || 'https://openrouter.ai/api/v1';

/**
 * A DeepSeek também fala a API da OpenAI — mesma fábrica, mesmo formato de
 * payload, sem SDK novo. O endpoint é a raiz que o provedor documenta (ele
 * também aceita `/v1`); o `@ai-sdk/openai` acrescenta `/chat/completions`.
 */
export const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com';

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
 * Toggle do raciocínio (thinking) da DeepSeek — knob DEEPSEEK_THINKING.
 * `'provider'` preserva o default do provedor (raciocínio LIGADO); `'disabled'`
 * injeta o desligamento no corpo das chamadas. Só a DeepSeek o lê.
 */
export type RaciocinioDeepseek = 'provider' | 'disabled';

/**
 * Desliga o raciocínio da DeepSeek no CORPO do request — sem tocar em prompt,
 * tools, temperatura ou qualquer outro parâmetro da chamada.
 *
 * POR QUE UM CAMPO, E POR QUE DOIS NOMES: o raciocínio da DeepSeek nasce LIGADO
 * e o token de raciocínio é cobrado como SAÍDA (medido em produção: ~8× a saída
 * do OpenAI por turno e +22 s de latência — o desconto de preço foi anulado
 * pelo volume). São DUAS superfícies e cada uma lê um nome diferente (doc
 * oficial, "Thinking Mode › Toggle and Effort Control"):
 *
 *   - Responses API (`/responses`)   → `reasoning.effort = 'none'` desliga;
 *   - Chat Completions               → `thinking.type = 'disabled'`.
 *
 * O SDK instalado (`createOpenAI(...)(modelId)`) fala a Responses API — o teste
 * `deepseek-sem-raciocinio.test.ts` prende essa rota. Por isso vão os DOIS
 * campos: o provedor ignora em SILÊNCIO o que a rota não conhece (não erra),
 * então o desligamento vale em qualquer uma das duas — e o caminho real do SDK
 * é o `/responses`, que só entende `reasoning`.
 *
 * O corpo é lido por cima do `init` que o SDK montou, então nada mais muda; um
 * `reasoning` já presente é preservado (só o `effort` é forçado a 'none').
 */
function comRaciocinioDesligado(inner: typeof fetch): typeof fetch {
  return (input, init) => {
    const corpo = init?.body;
    if (typeof corpo === 'string') {
      try {
        const json = JSON.parse(corpo) as Record<string, unknown>;
        const reasoningBruto = json['reasoning'];
        const reasoning =
          reasoningBruto !== null && typeof reasoningBruto === 'object'
            ? (reasoningBruto as Record<string, unknown>)
            : {};
        return inner(input, {
          ...init,
          body: JSON.stringify({
            ...json,
            thinking: { type: 'disabled' },
            reasoning: { ...reasoning, effort: 'none' },
          }),
        });
      } catch {
        // Corpo não-JSON: repassa intacto. Um ajuste de tuning nunca pode
        // derrubar a chamada que ele veio otimizar.
      }
    }
    return inner(input, init);
  };
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
export function createDefaultRegistry(opts?: {
  allowedHosts?: string[];
  /**
   * Knob DEEPSEEK_THINKING aplicado à fábrica da DeepSeek (e SÓ a ela — a
   * fábrica é dela). Ausente = 'provider' = nada é injetado.
   */
  deepseekThinking?: RaciocinioDeepseek;
}): ProviderRegistry {
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
      const provider = createOpenAI({
        apiKey,
        baseURL: endpoint,
        headers: cabecalhosDeAtribuicaoOpenRouter(),
        fetch: contain(endpoint),
      });
      // Chat Completions, NÃO Responses: a OpenRouter fala a API da OpenAI
      // (chat/completions). O `createOpenAI()(modelId)` desta versão do SDK usa
      // o endpoint /responses por padrão, e a OpenRouter NÃO o implementa para
      // todo modelo: medido em 2026-09-19, `google/gemini-2.5-flash-lite`
      // devolvia "Invalid JSON response" (o SDK tentava
      // /responses e recebia a página do chat), enquanto gpt-4o/4.1 passavam
      // por sorte do roteamento. `.chat()` fixa o formato que a OpenRouter
      // realmente serve, para qualquer família de modelo.
      return provider.chat(modelId);
    },
    /**
     * DeepSeek é OpenAI-compatível e aceita um `base_url` próprio pela mesma
     * razão da OpenRouter: o painel de provedores oferece apontar para um
     * gateway, e a allowlist do egress precisa ser a DELE — fixá-la no endpoint
     * canônico bloquearia a configuração que a própria tela permitiu.
     */
    deepseek: (apiKey, modelId, baseUrl) => {
      const endpoint = baseUrl ?? DEEPSEEK_ENDPOINT;
      const contido = contain(endpoint);
      const fetchFinal =
        opts?.deepseekThinking === 'disabled' ? comRaciocinioDesligado(contido) : contido;
      return createOpenAI({ apiKey, baseURL: endpoint, fetch: fetchFinal })(modelId);
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
