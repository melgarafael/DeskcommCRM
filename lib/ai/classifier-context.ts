/** Janela comum dos classificadores; o Jev só recebe histórico com aceite específico.
 * Não é a memória do agente que conversa: serve só para desambiguar a mensagem atual.
 */
export const LEGACY_ROUTER_CONTEXT_MESSAGES = 4;
export const CLASSIFIER_CONTEXT_MESSAGES = 8;
export const NEW_ROUTER_CONTEXT_MESSAGES = CLASSIFIER_CONTEXT_MESSAGES;
export const MAX_CLASSIFIER_CONTEXT_MESSAGES = 16;
export const MAX_CLASSIFIER_CONTEXT_CHARS = 1000;

/** Campo nativo de ai_routers.config. Ausente/inválido não vira configuração salva. */
export function quantidadeDeHistoricoSalva(config: unknown): number | null {
  const valor = config !== null && typeof config === 'object' && !Array.isArray(config)
    ? (config as Record<string, unknown>).context_message_count : undefined;
  return typeof valor === 'number' && Number.isInteger(valor) && valor >= 0 && valor <= MAX_CLASSIFIER_CONTEXT_MESSAGES
    ? valor : null;
}

export interface ClassifierContextMessage {
  direction: 'inbound' | 'outbound';
  body: string;
}

/** Entrada em ordem cronológica; mantém somente as mensagens mais recentes. */
export function contextoDoClassificador(mensagens: readonly ClassifierContextMessage[], quantidade = CLASSIFIER_CONTEXT_MESSAGES) {
  const limite = Math.max(0, Math.min(MAX_CLASSIFIER_CONTEXT_MESSAGES, quantidade));
  return limite === 0 ? [] : mensagens.slice(-limite).map((m) => ({ ...m, body: m.body.slice(0, MAX_CLASSIFIER_CONTEXT_CHARS) }));
}
