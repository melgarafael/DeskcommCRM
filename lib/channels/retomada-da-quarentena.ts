/**
 * LIBERAR É DEVOLVER A MENSAGEM AO FLUXO — não é apagar uma marca.
 *
 * ─── O que "liberar" precisa significar ─────────────────────────────────────
 *
 * A quarentena segurou o EFEITO (agente, automação, notificação), não a
 * mensagem. Então liberar tem de fazer o que a ingestão teria feito: rodar
 * `aplicarEfeitosPosEntrada` para aquela linha, com a marca já apagada — o
 * MESMO caminho, sem um segundo conjunto de regras que diverge do primeiro.
 *
 * ─── Por que NÃO se reemite o evento `message.received` ────────────────────
 *
 * Porque o evento original já foi consumido (como `skipped`) e reemitir um
 * `message.received` velho re-dispara tudo o que ele carrega: push para a
 * equipe, cotação de conversão de anúncio, match de campanha, reatividade de
 * follow-up e o worker de resposta. Numa revisão de vinte mensagens isso é
 * exatamente o "reenvio em massa" que ninguém pediu. O que a liberação
 * restaura é o fluxo da MENSAGEM (o turno do agente e os efeitos de entrada);
 * automação por evento volta a valer para a próxima mensagem do contato.
 *
 * ─── Duas travas contra o reenvio retroativo ───────────────────────────────
 *
 * 1. A mensagem é de ENTRADA? Envio nosso não tem efeito de entrada, e liberar
 *    um deles não faria nada — devolve `nao_e_entrada`.
 * 2. Já houve resposta depois dela? Se sim, liberar só apaga a marca: a IA já
 *    respondeu, e re-despachar faria o cliente receber uma segunda resposta
 *    para a mesma fala. É o lado oposto (g) da #4026 escrito em código.
 *
 * O dreno do turno ainda tem o anti-backlog: se o contato mandou mensagem mais
 * nova, o evento desta é considerado superado e não vira turno. As três regras
 * juntas são o que impede a liberação de virar rajada.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { aplicarEfeitosPosEntrada, type EntradaDeMensagem } from "@/lib/channels/pos-entrada";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";

export const ORIGEM_DA_RETOMADA = "retomada_de_quarentena";

export type DesfechoDaRetomada =
  | { retomou: true }
  | {
      retomou: false;
      motivo: "mensagem_nao_encontrada" | "nao_e_entrada" | "ja_respondida" | "falha";
    };

/**
 * Devolve ao fluxo normal a mensagem que acabou de sair da quarentena.
 *
 * Chamado pela rota DEPOIS de `liberarMensagemDaQuarentena` — a marca já está
 * apagada, então o gate de `aplicarEfeitosPosEntrada` não segura nada.
 */
export async function retomarFluxoDaMensagemLiberada(
  admin: SupabaseClient,
  pedido: { organizationId: string; messageId: string },
): Promise<DesfechoDaRetomada> {
  try {
    const { data, error } = await admin
      .from("messages")
      .select("id, body, contact_id, conversation_id, channel_session_id, direction, sent_at")
      .eq("organization_id", pedido.organizationId)
      .eq("id", pedido.messageId)
      .maybeSingle();

    if (error) {
      logger.warn("[quarentena] retomada: leitura da mensagem falhou", {
        organization_id: pedido.organizationId,
        message_id: pedido.messageId,
        detail: error.message.slice(0, 160),
      });
      return { retomou: false, motivo: "falha" };
    }

    const msg = data as {
      id: string;
      body: string | null;
      contact_id: string;
      conversation_id: string;
      channel_session_id: string;
      direction: string;
      sent_at: string | null;
    } | null;
    if (!msg) return { retomou: false, motivo: "mensagem_nao_encontrada" };
    if (msg.direction !== "inbound") return { retomou: false, motivo: "nao_e_entrada" };

    // (g) Nada de reenvio retroativo: quem já foi respondido depois desta
    // mensagem não recebe resposta nova por causa de uma liberação.
    const { data: respondida, error: erroResposta } = await admin
      .from("messages")
      .select("id")
      .eq("organization_id", pedido.organizationId)
      .eq("conversation_id", msg.conversation_id)
      .eq("direction", "outbound")
      .gte("sent_at", msg.sent_at ?? new Date(0).toISOString())
      .limit(1)
      .maybeSingle();

    if (erroResposta) {
      // Fail-open para a conversa (não mexe em nada): na dúvida, não re-despacha.
      logger.warn("[quarentena] retomada: leitura de resposta existente falhou — não retoma", {
        organization_id: pedido.organizationId,
        message_id: pedido.messageId,
        detail: erroResposta.message.slice(0, 160),
      });
      return { retomou: false, motivo: "falha" };
    }
    if (respondida) return { retomou: false, motivo: "ja_respondida" };

    const { data: conversa } = await admin
      .from("conversations")
      .select("id, channel")
      .eq("organization_id", pedido.organizationId)
      .eq("id", msg.conversation_id)
      .maybeSingle();
    const { data: contato } = await admin
      .from("contacts")
      .select("id, name, display_name")
      .eq("organization_id", pedido.organizationId)
      .eq("id", msg.contact_id)
      .maybeSingle();

    const entrada: EntradaDeMensagem = {
      organizationId: pedido.organizationId,
      contactId: msg.contact_id,
      conversationId: msg.conversation_id,
      messageId: msg.id,
      channelSessionId: msg.channel_session_id,
      texto: msg.body,
      nomeDoContato: nomeDoContato(contato as { name?: string | null; display_name?: string | null } | null),
      origem: ORIGEM_DA_RETOMADA,
      canal: (conversa as { channel: string | null } | null)?.channel ?? undefined,
    };

    await aplicarEfeitosPosEntrada(admin as never, entrada);
    return { retomou: true };
  } catch (err) {
    logger.warn("[quarentena] retomada falhou", {
      organization_id: pedido.organizationId,
      message_id: pedido.messageId,
      detail: err instanceof Error ? err.message.slice(0, 160) : "unknown",
    });
    return { retomou: false, motivo: "falha" };
  }
}
