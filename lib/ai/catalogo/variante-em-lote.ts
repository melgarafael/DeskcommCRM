/**
 * VARIANTE EM LOTE NÃO CONVERSA.
 *
 * A OpenRouter publica, ao lado de muitos modelos, uma cópia com o sufixo
 * `:batch` (`openai/gpt-6-luna:batch`, `deepseek/deepseek-v4.1-flash:batch`) e
 * metade do preço. Ela só existe para processamento em lote: no endpoint de
 * chat devolve 404 — `cannot be used with the chat/completions endpoint` —,
 * e o atendente, o classificador de etapa e o detector de jailbreak, que
 * herdam o mesmo modelo, falham juntos.
 *
 * Medido numa instalação fresca: três modelos escolhidos na aba Testar da
 * Laura, dois deles `:batch`, os dois com 404 em `llm_calls`. O operador via
 * "verifique chave, provedor ou modelo" e a chave estava válida.
 *
 * A régua é o SUFIXO, não o nome de um provedor: a convenção é da OpenRouter,
 * mas nenhuma feature precisa saber disso para recusar o id.
 */
const SUFIXO_EM_LOTE = ":batch";

export function ehVarianteEmLote(modelId: string | null | undefined): boolean {
  return typeof modelId === "string" && modelId.trim().toLowerCase().endsWith(SUFIXO_EM_LOTE);
}
