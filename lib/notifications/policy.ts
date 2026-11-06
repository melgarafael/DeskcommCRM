/**
 * A LINHA VEIO DO ACERVO IMPORTADO? (issue #3427)
 *
 * O importador de histórico do WhatsApp grava conversas antigas direto em
 * `public.messages` (cron `historico-import`, até 300 linhas por rodada),
 * marcadas em `lib/channels/historico/mapear.ts` com
 * `metadata.historico_importado = "true"`. Para o realtime, inserir na tabela
 * é indistinguível de mensagem que acabou de chegar — e o passado vira aviso
 * de "Nova mensagem" com som, três pedidos HTTP por linha, para todo mundo com
 * o app aberto.
 *
 * O push do servidor já não sai: a migration 0760 corta `fn_emit_message_event`
 * na marca, com `coalesce(new.metadata->>'historico_importado','') = 'true'`.
 * O aviso do navegador não passa pelo banco, então o corte tem de existir aqui
 * também — nesta função, que é a decisão única do hook.
 *
 * Duas formas são aceitas de propósito: a string `"true"` é o que o mapeador
 * grava, e o booleano `true` é o que o jsonb entrega em linhas escritas por
 * caminhos que gravam a marca como booleano (o gatilho da 0686 e o
 * `media-persist-worker` tratam as duas — ver o caso 8b de
 * `tests/invariants/mensagem-do-vendedor-e-atividade.test.ts`). Qualquer outro
 * valor, inclusive `"false"`, NÃO é histórico: um aviso a mais incomoda, um a
 * menos deixa cliente sem resposta.
 */
export function veioDoHistoricoImportado(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const marca = (metadata as Record<string, unknown>).historico_importado;
  return marca === "true" || marca === true;
}

export function shouldNotifyInbound(input: {
  direction?: string | null;
  conversationId?: string | null;
  openConversationId?: string | null;
  tabFocused: boolean;
  tipo?: unknown;
  /** `messages.metadata` da linha do realtime; a marca do acervo cala o aviso. */
  metadata?: unknown;
}): boolean {
  if (input.tipo === "reassinado") return false;
  if (input.direction !== "inbound") return false;
  if (!input.conversationId) return false;
  if (veioDoHistoricoImportado(input.metadata)) return false;
  if (input.tabFocused && input.openConversationId === input.conversationId) return false;
  return true;
}
