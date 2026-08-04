/**
 * Adapter WAHA — o primeiro `ChannelAdapter`, e de propósito o mais burro
 * possível: cada método delega ao `lib/waha/*` que já existe e já é testado.
 * Reimplementar aqui é como se perde paridade de comportamento sem perceber.
 *
 * Nenhuma regra de negócio mora neste arquivo (ver `ChannelAdapter` em ../types).
 */
import { getWahaClient } from "@/lib/waha/client";
import { wahaSendPlanFor } from "@/lib/waha/media-send";
import { bareWaMessageId, parseWahaMessageId } from "@/lib/waha/message-id";
import { resolveWahaChatId } from "@/lib/waha/send";
import type { ChannelAdapter, OutboundEnvelope, RecipientInput } from "../types";

export const wahaAdapter: ChannelAdapter = {
  provider: "waha",

  resolveRecipient(input: RecipientInput): string | null {
    return resolveWahaChatId(input);
  },

  /**
   * As duas pontas do mesmo id, porque os engines gravam lados opostos:
   *   NOWEB — o envio devolve o id cru (`3EB0…`) e o webhook manda o composto
   *           `true_<chatId>_3EB0…`
   *   WEBJS — os dois lados usam o `_serialized` completo
   *
   * Reduzir ao bare cobre o segundo caso; para o primeiro é preciso CONSTRUIR o
   * composto a partir do destinatário — daí o `recipient`. Sem ele o par nunca
   * contém a forma que o webhook realmente gravou.
   *
   * `true_` porque o eco de um envio nosso é sempre `fromMe`.
   */
  echoExternalIds(input: { externalId: string; recipient: string }): string[] {
    const bare = bareWaMessageId(input.externalId);
    return [...new Set([input.externalId, bare, `true_${input.recipient}_${bare}`])];
  },

  // Mesmo pre-check que o handler já fazia com `getWahaClient() !== null`,
  // movido para trás do seam. `getWahaClient` lê o env a cada chamada (não
  // memoiza), então o estado aqui é sempre o corrente.
  isConfigured(): boolean {
    return getWahaClient() !== null;
  },

  // `unknownError` é gravado em `messages.error_message` quando o throw não é
  // um `Error` — valor observável no banco, por isso ele ATRAVESSA o seam com o
  // literal intacto em vez de virar uma string neutra.
  codes: {
    notConfigured: "waha_not_configured",
    sendFailed: "waha_error",
    unknownError: "waha_unknown",
  },

  // A URL vem assinada pelo CDN do WhatsApp e EXPIRA (~9 dias, medido). Quem
  // chama baixa e persiste; guardar a URL faria a foto sumir sozinha depois.
  async fetchProfilePictureUrl(input: {
    sessionRef: string;
    recipient: string;
  }): Promise<string | null> {
    const client = getWahaClient();
    if (!client) return null;
    return client.getProfilePictureUrl(input.sessionRef, input.recipient);
  },

  async send(envelope: OutboundEnvelope): Promise<{ externalId: string | null }> {
    const client = getWahaClient();
    // Sem env de WAHA o comportamento atual é NOOP, não erro: a UI mostra o
    // banner de "container não está no ar". Transformar em exceção mudaria o
    // comportamento visível — proibido nas Fases 0–2.
    if (!client) return { externalId: null };

    const res = envelope.media
      ? await client.sendMedia(
          envelope.sessionRef,
          envelope.to,
          wahaSendPlanFor(envelope.kind, envelope.media),
        )
      : await client.sendMessage(envelope.sessionRef, envelope.to, envelope.body ?? "");

    return { externalId: parseWahaMessageId(res) };
  },
};
