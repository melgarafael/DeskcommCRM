import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

/**
 * O CARIMBO DA CONVERSA, E O QUE FAZER QUANDO ELE FALHA — um lugar só.
 *
 * `fn_mark_conversation_message` é quem move `last_message_at`,
 * `last_inbound_at`/`last_outbound_at`, a prévia, o contador de não lidas e
 * `contacts.last_activity_at`. Sem ela a mensagem existe e a conversa fica
 * parada: some da ordenação da Inbox, e a janela de 24h do canal oficial não
 * abre.
 *
 * ═══ Por que virou função compartilhada ═════════════════════════════════════
 *
 * Os três canais chamavam a MESMA RPC e tratavam a falha de três jeitos
 * diferentes, em ordem decrescente de utilidade:
 *
 *   • WAHA     — emitia `whatsapp.conversation_mark_failed` em `event_log`.
 *                Registro durável: sobrevive ao contêiner e é consultável.
 *   • Zernio   — `logger.warn`. Some no próximo restart.
 *   • Meta     — **ignorava o retorno inteiro.** E o comentário acima da
 *                chamada afirmava o contrário: "o erro sobe como `failed`
 *                parcial no log do chamador em vez de sumir". Sumia.
 *
 * O canal oficial era o pior dos três justamente onde a falha dói mais: é ele
 * que tem janela de 24h, e conversa sem carimbo é janela que ninguém vê fechar.
 *
 * Três cópias de uma chamada não divergem por descuido, divergem por
 * construção — cada uma foi escrita numa semana diferente. O guard único é
 * menor que três guards e não tem como ficar desalinhado.
 *
 * ═══ Por que a falha NÃO derruba a ingestão ═════════════════════════════════
 *
 * A mensagem já está gravada quando isto roda. Lançar aqui devolveria erro ao
 * provedor, que reentregaria o webhook inteiro — e a reentrega não conserta o
 * carimbo, só duplica o trabalho. Perder o carimbo é ruim; perder a mensagem, e
 * fazer o provedor martelar, é pior.
 *
 * ═══ Por que o evento não tem consumidor, e isso é deliberado ═══════════════
 *
 * `whatsapp.conversation_mark_failed` não tem handler registrado, então o dreno
 * (que filtra por `event_type` com handler) nunca o seleciona: ele fica em
 * `event_log` como REGISTRO, não como trabalho pendente. É o que se quer — há
 * um rastro consultável de toda conversa que ficou para trás, sem nada tentando
 * "consertar" automaticamente um carimbo cuja hora já passou.
 */
export async function marcarConversaComMensagem(
  admin: SupabaseClient,
  args: {
    organizationId: string;
    conversationId: string;
    direction: "inbound" | "outbound";
    preview: string;
    at: string;
    /** Nome do canal, só para o log da segunda linha de defesa. */
    canal: string;
  },
): Promise<void> {
  const { error } = await admin.rpc("fn_mark_conversation_message" as never, {
    p_conv: args.conversationId,
    p_direction: args.direction,
    p_preview: args.preview,
    p_at: args.at,
  } as never);
  if (!error) return;

  const { error: erroAviso } = await admin.rpc("emit_event" as never, {
    p_event_type: "whatsapp.conversation_mark_failed",
    p_entity_kind: "conversation",
    p_entity_id: args.conversationId,
    // A prévia NÃO entra no payload: ela é o texto da mensagem do cliente, e
    // isto é registro operacional, não cópia de conteúdo. O que se precisa
    // saber para agir é qual conversa, que sentido, e o erro.
    p_payload: { direction: args.direction, canal: args.canal, erro: error.message },
    p_metadata: { severity: "warn" },
    p_organization_id: args.organizationId,
  } as never);

  if (erroAviso) {
    // Segunda linha de defesa: o próprio canal de aviso caiu. Aqui o log do
    // processo é o que sobra — é para ESTE caso que ele existe, não como rotina.
    logger.error("[canais] o carimbo falhou E o aviso também", {
      canal: args.canal,
      conversa: args.conversationId,
      erro: error.message,
      aviso: erroAviso.message,
    });
  }
}
