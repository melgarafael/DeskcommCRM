/**
 * Adapter do chat da OLX (#2927) — o canal dos anúncios, traduzido para o
 * contrato de `ChannelAdapter`.
 *
 * Burro de propósito, como os irmãos: traduz formato e nada mais. Janela,
 * limite, horário e throttle vivem na cadeia `before_send`
 * (`docs/doctrine/restricao-de-canal.md`).
 *
 * ─── O endereço NÃO é telefone ─────────────────────────────────────────────
 *
 * A OLX endereça por THREAD: `chatId` é o identificador que ela inventa para a
 * conversa de um anúncio, e o envio só aceita esse id (`{"chatId",
 * "messageId", "textMessage"}`). Por isso `resolveRecipient` devolve a sentinela
 * `"olx-chat"`, como o canal social: o endereço real viaja em
 * `OutboundEnvelope.providerConversationId`, que é o `chatId` gravado em
 * `conversations.provider_conversation_id` pela ingestão. Sem ele não há para
 * onde mandar, e o envio recusa em vez de inventar destinatário a partir de um
 * telefone que a thread não usa.
 *
 * ─── O `messageId` somos nós que escolhemos ────────────────────────────────
 *
 * O corpo do envio exige um `messageId`, e a resposta de sucesso é só `200`
 * (a doc não devolve id). Então geramos um UUID, mandamos, e o gravamos como
 * `external_id` — que é o mesmo id que volta no webhook de eco
 * (`origin: "seller"`), e é ele que permite reconhecer a repetição.
 *
 * ─── Canal desligado não envia ─────────────────────────────────────────────
 *
 * Sem token na sessão — que é o estado de toda instalação hoje, porque a OLX
 * exige cadastro de integrador e OAuth —, `send` LANÇA `olx_not_configured` e o
 * handler grava a mensagem como `queued` com o motivo, em vez de fingir um
 * `sent` sem id.
 */
import { randomUUID } from "node:crypto";

import { createAdminClient } from "@/lib/supabase/admin";

import type {
  ChannelAdapter,
  ChannelTenantScope,
  OutboundEnvelope,
  RecipientInput,
} from "../types";
import { resolverCredenciaisOlx } from "../olx/credentials";
import { OLX_AUTOSERVICE_BASE, OLX_CAMINHO_DE_ENVIO } from "../olx/webhook";

const NAO_CONFIGURADO = "olx_not_configured";

/** Sentinelas de endereço — a OLX não endereça por telefone (ver o cabeçalho). */
const ENDERECO_DE_THREAD = "olx-chat";

export const olxAdapter: ChannelAdapter = {
  provider: "olx",

  resolveRecipient(input: RecipientInput): string | null {
    // Grupo não existe neste canal: a thread é sempre um anúncio × um comprador.
    if (input.isGroup) return null;
    return ENDERECO_DE_THREAD;
  },

  /**
   * `true` sempre, como o Datafy: a credencial vive na SESSÃO e este método é
   * síncrono. Quem desiste é o `send`, que lança `olx_not_configured`.
   */
  isConfigured(): boolean {
    return true;
  },

  codes: {
    notConfigured: NAO_CONFIGURADO,
    sendFailed: "olx_error",
    unknownError: "olx_unknown",
  },

  /**
   * Envia texto pela thread. O corpo é o documentado em
   * `developers.olx.com.br/chat/send_message.html`:
   *
   *   POST https://apps.olx.com.br/autoservice/v1/chat/send
   *   Authorization: Bearer <token>
   *   {"textMessage": "...", "messageId": "...", "chatId": "..."}
   *
   * O TOKEN NUNCA ENTRA EM MENSAGEM DE ERRO nem em log: o detalhe que sobe é
   * código HTTP + `error` do corpo (quando houver), e nada do header.
   */
  async send(envelope: OutboundEnvelope): Promise<{ externalId: string | null }> {
    if (envelope.kind !== "text") {
      // A API do chat só tem `textMessage`. Recusar aqui, com o tipo nomeado, é
      // melhor que mandar um corpo que ela ignoraria em silêncio.
      throw new Error(`olx_unsupported_kind: ${envelope.kind}`);
    }

    const chatId = envelope.providerConversationId;
    if (!chatId) {
      throw new Error(
        `${NAO_CONFIGURADO}: a OLX responde pela thread do anúncio — aguarde uma mensagem do comprador para responder.`,
      );
    }

    const creds = await resolverCredenciaisOlx(createAdminClient(), {
      organizationId: envelope.organizationId,
      conta: envelope.sessionRef,
    });
    if (!creds) {
      throw new Error(
        `${NAO_CONFIGURADO}: nenhuma credencial gravada para esta conta (OAuth com escopo chat).`,
      );
    }

    await envelope.beforeSend?.();

    const messageId = randomUUID();
    let res: Response;
    try {
      res = await fetch(`${OLX_AUTOSERVICE_BASE}${OLX_CAMINHO_DE_ENVIO}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${creds.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          textMessage: envelope.body ?? "",
          messageId,
          chatId,
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      // Erro de transporte: a mensagem do `fetch` não carrega header nenhum, mas
      // ela é cortada e reetiquetada mesmo assim — quem lê o `error_code` da
      // mensagem precisa saber de qual canal veio.
      const detalhe = err instanceof Error ? err.message : "erro_desconhecido";
      throw new Error(`olx_transport: ${detalhe.slice(0, 200)}`);
    }

    if (!res.ok) {
      const corpo = (await res.json().catch(() => ({}))) as { error?: unknown; message?: unknown };
      const doCorpo =
        typeof corpo.error === "string"
          ? corpo.error
          : typeof corpo.message === "string"
            ? corpo.message
            : "";
      throw new Error(`olx_${res.status}: ${(doCorpo || `http_${res.status}`).slice(0, 200)}`);
    }

    // 200 sem id no corpo (a doc não devolve um): o `external_id` é o id que NÓS
    // mandamos e que a OLX usa na thread — é ele que o eco devolve.
    return { externalId: messageId };
  },
};
