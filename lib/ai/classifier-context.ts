/** Janela do classificador de intenção, compartilhada pela IA convencional e pelo Jev.
 * Não é a memória do agente que conversa: serve só para desambiguar a mensagem atual.
 */
export const CLASSIFIER_CONTEXT_MESSAGES = 4;
export const NEW_ROUTER_CONTEXT_MESSAGES = 8;
export const MAX_CLASSIFIER_CONTEXT_MESSAGES = 16;
export const MAX_CLASSIFIER_CONTEXT_CHARS = 1000;

export interface ClassifierContextMessage {
  direction: 'inbound' | 'outbound';
  body: string;
}

/** Entrada em ordem cronológica; mantém somente as mensagens mais recentes. */
export function contextoDoClassificador(mensagens: readonly ClassifierContextMessage[], quantidade = CLASSIFIER_CONTEXT_MESSAGES) {
  const limite = Math.max(0, Math.min(MAX_CLASSIFIER_CONTEXT_MESSAGES, quantidade));
  return limite === 0 ? [] : mensagens.slice(-limite).map((m) => ({ ...m, body: m.body.slice(0, MAX_CLASSIFIER_CONTEXT_CHARS) }));
}
