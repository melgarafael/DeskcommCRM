import type { LanguageModelUsage } from "ai";

/**
 * Num laço de ferramentas, o passo seguinte tem de ler do cache TUDO o que o
 * passo anterior deixou nele: o que ele leu mais o que ele escreveu. A régua não
 * é o `inputTokens` do passo anterior — ele inclui a cauda depois do último ponto
 * de cache, que nunca é cacheada (medido contra o modelo real em 03/11: a leitura
 * do passo 2 é igual à escrita do passo 1, e o prompt do passo 1 passa dela por 1
 * a 4 tokens estruturais). Usado pelo smoke da OpenRouter (scripts/smoke-llm.ts).
 */
export function passoSeguinteLeuOCache(
  anterior: Pick<LanguageModelUsage, "inputTokenDetails">,
  seguinte: Pick<LanguageModelUsage, "inputTokenDetails">,
): { deixado: number; lido: number; ok: boolean } {
  const deixado = (anterior.inputTokenDetails.cacheReadTokens ?? 0) + (anterior.inputTokenDetails.cacheWriteTokens ?? 0);
  const lido = seguinte.inputTokenDetails.cacheReadTokens ?? 0;
  // Nada deixado é sonda cega, não aprovação: 0 ≥ 0 passaria sem cache nenhum.
  return { deixado, lido, ok: deixado > 0 && lido >= deixado };
}
