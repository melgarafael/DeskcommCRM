/**
 * Régua ÚNICA do que conta como chamada ELEGÍVEL a cache de prompt (#4362).
 *
 * O provedor só guarda prefixo em cache a partir de um mínimo de tokens de
 * ENTRADA (1.024 na OpenAI e na Anthropic; abaixo disso a chamada nunca produz
 * `cache_read`). Classificadores, conferências de campo e extrações curtas caem
 * justamente aí: postas no denominador, entram como "0% de cache" sem que exista
 * defeito de prefixo nenhum — e afundam a razão, que é o que fazia o aviso
 * "cache hit de prompt abaixo do alvo" disparar sozinho (#4362).
 *
 * Por isso a régua mora AQUI e não em cada consumidor: a razão do run e o aviso
 * (`lib/agent-engine/obs/metrics.ts`) e a taxa da tela Uso de IA
 * (`lib/ai/usage/aggregate.ts`, servida por `fn_uso_de_ia`) medem a mesma coisa
 * com o mesmo corte. Duas cópias divergem na primeira mudança de provedor — e aí
 * o aviso e a tela passam a discordar sobre o mesmo período.
 *
 * O espelho em SQL está em `supabase/migrations/*_uso_de_ia_cache_so_cacheaveis.sql`
 * (`input_tokens >= 1024`) e no comentário da função `fn_uso_de_ia`; o teste de
 * unidade `tests/unit/uso-de-ia-tela-honesta.test.ts` lê o arquivo da migration e
 * reprova se o número de lá deixar de ser este.
 */
export const MIN_TOKENS_DE_ENTRADA_PARA_CACHE = 1024;
