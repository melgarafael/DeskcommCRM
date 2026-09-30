/** Janela do classificador de intenção, compartilhada pela IA convencional e pelo Jev.
 * Não é a memória do agente que conversa: serve só para desambiguar a mensagem atual.
 */
export const CLASSIFIER_CONTEXT_MESSAGES = 4;

export interface ClassifierContextMessage {
  direction: 'inbound' | 'outbound';
  body: string;
}

/** Entrada em ordem cronológica; mantém somente as mensagens mais recentes. */
export function contextoDoClassificador(mensagens: readonly ClassifierContextMessage[]) {
  return mensagens.slice(-CLASSIFIER_CONTEXT_MESSAGES);
}
