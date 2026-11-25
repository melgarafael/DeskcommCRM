/**
 * Adapter do chat no site (Spec 36, fatia F1).
 *
 * Burro como os irmãos: traduz formato e nada mais. Janela, cap e horário são da
 * cadeia `before_send` (`docs/doctrine/restricao-de-canal.md`).
 *
 * ─── Nenhum terceiro no envio ─────────────────────────────────────────────
 *
 * O chat não passa por plataforma nenhuma: a resposta do atendente é gravada no
 * banco pelo handler, e o widget do visitante a lê de lá. Por isso `send` não
 * faz chamada de rede — ele devolve o id que o próprio canal dá à mensagem, no
 * formato `wc:out:<uuid>` (sem a chave da sessão, que não sai no id), e o handler
 * grava esse id em `messages.external_id`.
 *
 * ─── O destinatário NÃO sai do contato ───────────────────────────────────
 *
 * Como no Telegram, o endereço é a thread: `conversations.provider_conversation_id`
 * guarda o `visitante_id`. `resolveRecipient` devolve só um marcador, para o
 * envelope ter um `to` não nulo.
 */
import { randomId } from "@/lib/random-id";

import type { ChannelAdapter, ChannelHealth, OutboundEnvelope } from "../types";

/**
 * O marcador de destinatário deste canal. Não é o `visitante_id` de propósito:
 * `resolveRecipient` recebe o CONTATO, e o endereço vive na conversa.
 */
const DESTINO_PELA_THREAD = "provider-chat";

export const webchatAdapter: ChannelAdapter = {
  provider: "webchat",

  resolveRecipient(): string | null {
    return DESTINO_PELA_THREAD;
  },

  /**
   * SEMPRE `true`: não há credencial de terceiro a conferir. Módulo ligado e
   * conexão ativa são conferidos nas rotas públicas e na ingestão; na saída,
   * quem barra é o handler, pelo estado da conexão.
   */
  isConfigured(): boolean {
    return true;
  },

  async send(envelope: OutboundEnvelope): Promise<{ externalId: string | null }> {
    if (envelope.kind !== "text") {
      // Mídia do chat não existe na F1. Recusar nomeando o motivo é melhor que
      // mandar a legenda e perder o anexo em silêncio.
      throw new Error(
        `webchat_media_not_supported: este canal ainda não envia ${envelope.kind} (fora da F1 do chat no site).`,
      );
    }
    if (!envelope.body || envelope.body.trim().length === 0) {
      throw new Error("webchat_empty_body: mensagem de texto sem corpo.");
    }
    return { externalId: `wc:out:${randomId()}` };
  },

  /**
   * Sempre de pé, sem rede: o chat não tem terceiro para sondar. A conexão
   * ativa e o módulo ligado são conferidos nas rotas e na ingestão, então não há
   * estado de queda que esta sonda pudesse medir.
   */
  async checkHealth(): Promise<ChannelHealth> {
    return { reachable: true, status: "WORKING", detail: null };
  },

  codes: {
    notConfigured: "webchat_not_configured",
    sendFailed: "webchat_error",
    unknownError: "webchat_unknown",
  },
};
