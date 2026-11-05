/**
 * O embrulho do `fetch` que põe os pontos de cache dos Claude no corpo do pedido
 * à OpenRouter. Mora fora de providers.ts de propósito: a prova paga
 * (scripts/prova-cache-openrouter.ts) manda este MESMO corpo a cada provedor de
 * origem, e providers.ts arrasta o env do app (Supabase) para quem o importa.
 * Aqui não entra nada além do tipo do TTL.
 */
import type { CacheTtl } from './stable-prefix';

/**
 * O cache de UMA chamada, decidido no seam (`runModelCall`): o TTL do prefixo
 * estável, se há laço de ferramentas (a cauda de 5 min) e a chave da sessão que
 * fixa o provedor de origem. Só a fábrica `openrouter` lê, e só com o knob
 * OPENROUTER_PROMPT_CACHE=on.
 */
export interface CacheDaChamada {
  ttl: CacheTtl;
  cauda: boolean;
  sessao: string;
}

/**
 * Os pontos de cache dos Claude pela OpenRouter oficial — knob
 * OPENROUTER_PROMPT_CACHE (ligado por padrão; `off` desliga).
 *
 * O `@ai-sdk/openai` no modo chat não converte `providerOptions.anthropic.cacheControl`,
 * então o prefixo estável chegava à OpenRouter sem ponto nenhum e era cobrado a
 * preço cheio em todo passo. A doc de prompt-caching da OpenRouter documenta
 * `cache_control` no bloco e na raiz, e `session_id` no corpo (fixa o provedor de
 * origem já no 1º sucesso). Aqui vão, por cima do corpo que o SDK montou:
 *
 *   1. o system (messages[0], onde o generateText põe o prefixo estável) vira um
 *      bloco com o MESMO texto e `cache_control` no TTL do knob LLM_CACHE_TTL.
 *      O knob só existe no env do motor (`lib/agent-engine/env.ts`): `lib/env.ts`
 *      não o declara, então as rotas do app que montam a config com o env de lá
 *      (assistente de propostas, teste de roteador) gravam sempre com 1 h; quem
 *      monta pelo env do motor (o worker, `request-deps.ts`) segue o knob. A
 *      diferença é anterior a este embrulho, que a herda.
 *      E quando o custo não vem da OpenRouter e o modelo não está na tabela, o
 *      preço é o do catálogo da instalação, que não tem tarifa de cache: leitura e
 *      gravação contam pela entrada (`custoComPrecoDaInstalacao`);
 *   2. `session_id`;
 *   3. com laço de ferramentas, `cache_control` na raiz (a cauda, 5 min).
 *
 * O modelo lê o mesmo texto: ferramentas e mensagens não mudam. Só `anthropic/*`:
 * todo provedor de origem de Claude serve os pesos da própria Anthropic, e fixar
 * sessão num modelo de pesos abertos poderia trocar a quantização.
 *
 * O corpo novo é montado DENTRO do try e a rede é chamada FORA dele: um erro da
 * rede nunca reenvia o pedido pelo caminho do "corpo não-JSON".
 */
export function comCacheDaAnthropicNoOpenRouter(inner: typeof fetch, cache: CacheDaChamada): typeof fetch {
  return (input, init) => {
    const corpo = init?.body;
    let novo: string | undefined;
    if (typeof corpo === 'string') {
      try {
        const json = JSON.parse(corpo) as Record<string, unknown>;
        if (typeof json['model'] === 'string' && /^~?anthropic\//.test(json['model'])) {
          const mensagens = Array.isArray(json['messages']) ? [...(json['messages'] as unknown[])] : [];
          const primeira = mensagens[0] as { role?: unknown; content?: unknown } | undefined;
          if (
            primeira !== undefined &&
            (primeira.role === 'system' || primeira.role === 'developer') &&
            typeof primeira.content === 'string'
          ) {
            mensagens[0] = {
              ...primeira,
              content: [
                { type: 'text', text: primeira.content, cache_control: { type: 'ephemeral', ttl: cache.ttl } },
              ],
            };
          }
          novo = JSON.stringify({
            ...json,
            ...(Array.isArray(json['messages']) ? { messages: mensagens } : {}),
            session_id: cache.sessao,
            ...(cache.cauda ? { cache_control: { type: 'ephemeral' } } : {}),
          });
        }
      } catch {
        // Corpo não-JSON: repassa intacto. Um ajuste de custo nunca pode
        // derrubar a chamada que ele veio baratear.
      }
    }
    return inner(input, novo === undefined ? init : { ...init, body: novo });
  };
}
