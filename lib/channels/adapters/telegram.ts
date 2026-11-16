/**
 * Adapter do bot do Telegram (Bot API — issue #3440, fatia T1).
 *
 * Burro como os irmãos: traduz formato e nada mais. Janela, cap, horário e
 * retry são da cadeia `before_send` (`docs/doctrine/restricao-de-canal.md`).
 *
 * ─── O destinatário NÃO sai do contato ─────────────────────────────────────
 *
 * Como no canal social, o endereço é um id que a plataforma entrega: o
 * `chat_id` do update, gravado em `conversations.provider_conversation_id` pela
 * ingestão. Telefone não existe aqui — o robô fala com quem o iniciou —, e é
 * exatamente por isso que este provider NÃO está em `PROVIDERS_DE_TELEFONE`:
 * quem tem um número na mão não alcança ninguém por este canal (#3358/#3364).
 *
 * `resolveRecipient` devolve um marcador, no molde do adapter das redes
 * sociais: o envelope precisa de um `to` não nulo para quem chama saber que há
 * destinatário, e o que endereça é `providerConversationId`.
 *
 * ─── Uma mensagem custa zero, mas não é de graça em atenção ────────────────
 *
 * `costPerMessage: false` na matriz — a Bot API não cobra por mensagem. O
 * limite que existe é de RITMO (≈1 msg/s por conversa, `minIntervalMs: 1000`):
 * estourar devolve `429` com `retry_after`, e o erro sobe com ele para quem
 * decide esperar.
 */
import { createAdminClient } from "@/lib/supabase/admin";

import { telegramCredsForBotId, telegramRequest } from "../bot/credentials";
import { telegramExternalId } from "../bot/webhook";
import type { ChannelAdapter, ChannelHealth, ChannelTenantScope, OutboundEnvelope, RecipientInput } from "../types";

/**
 * O marcador de destinatário deste canal.
 *
 * Não é o `chat_id` de propósito: `resolveRecipient` recebe o CONTATO, e o
 * contato do Telegram não carrega o chat. Inventar um valor que parecesse
 * endereço (um telefone vazio, um id falso) faria o handler gravar
 * `missing_phone_number` ou — pior — endereçar em silêncio para o lugar errado.
 */
const DESTINO_PELA_THREAD = "provider-chat";

/**
 * O `message_id` que o Telegram deu, extraído do nosso id canônico
 * (`tg:<robô>:<conversa>:<mensagem>`).
 *
 * Existe porque a citação (`reply_to_message_id`) precisa do id CRU: o Telegram
 * não conhece o nosso prefixo. Se o formato não casar, devolve `null` e a
 * mensagem sai solta — a citação é enfeite, nunca condição de envio.
 */
export function telegramMessageId(externalId: string): string | null {
  const partes = externalId.split(":");
  if (partes.length !== 4 || partes[0] !== "tg") return null;
  const id = partes[3];
  return id && /^\d+$/.test(id) ? id : null;
}

/** O `chat_id` a partir do id canônico — usado quando a conversa não tem thread. */
export function telegramChatIdFromExternalId(externalId: string): string | null {
  const partes = externalId.split(":");
  if (partes.length !== 4 || partes[0] !== "tg") return null;
  return partes[2] || null;
}

export const telegramAdapter: ChannelAdapter = {
  provider: "telegram",

  resolveRecipient(input: RecipientInput): string | null {
    // Grupo está fora da v1 (`groups: "none"`): devolver endereço aqui mandaria
    // a resposta para uma conversa que o produto não atende.
    if (input.isGroup) return null;
    return DESTINO_PELA_THREAD;
  },

  /**
   * SEMPRE `true`, pelo mesmo motivo medido do canal intermediado: a credencial
   * vive cifrada na SESSÃO, e este método é síncrono — não pode consultar o
   * banco. Responder `false` faria o handler gravar `queued` sem nunca tentar
   * enviar, com o canal conectado e funcionando.
   *
   * Quem desiste é `send`, que LANÇA: `{externalId: null}` faria o chamador
   * gravar `sent` sem id, dizendo "enviado" para algo que nunca saiu.
   */
  isConfigured(): boolean {
    return true;
  },

  async send(envelope: OutboundEnvelope): Promise<{ externalId: string | null }> {
    if (envelope.kind !== "text") {
      // A T2 da issue (#3440) cobre mídia. Recusar nomeando o motivo é melhor
      // que mandar o texto de uma legenda e perder o anexo em silêncio.
      throw new Error(
        `telegram_media_not_supported: este canal ainda não envia ${envelope.kind} (fatia T2 da #3440).`,
      );
    }
    if (!envelope.body || envelope.body.trim().length === 0) {
      throw new Error("telegram_empty_body: mensagem de texto sem corpo.");
    }

    const admin = createAdminClient();
    const creds = await telegramCredsForBotId(admin, {
      organizationId: envelope.organizationId,
      botId: envelope.sessionRef,
    });
    if (!creds) {
      throw new Error(
        "telegram_not_configured: nenhum token de bot para esta conexão. Reconecte em Conexões › Telegram.",
      );
    }

    // O endereço é a thread. Sem ela não há envio livre: o `chat_id` chega
    // junto com a primeira mensagem da pessoa.
    const chatId = envelope.providerConversationId;
    if (!chatId) {
      throw new Error(
        "telegram_no_conversation: a conversa não tem chat_id; espere a primeira mensagem do cliente neste robô.",
      );
    }

    const body: Record<string, unknown> = {
      chat_id: chatId,
      text: envelope.body,
      // Sem prévia de link o texto de um atendimento não vira cartão de site.
      disable_web_page_preview: true,
    };
    const citado = envelope.replyToExternalId ? telegramMessageId(envelope.replyToExternalId) : null;
    if (citado) body.reply_to_message_id = Number(citado);

    await envelope.beforeSend?.();

    const enviada = await telegramRequest<{ message_id?: number }>(creds.token, "sendMessage", body);
    if (typeof enviada?.message_id !== "number") {
      // Envio aceito sem id: o chamador precisa saber que NÃO sabe o id, em vez
      // de gravar `null` como se fosse sucesso (`isConfigured` acima).
      throw new Error("telegram_send_without_id: a plataforma aceitou o envio sem devolver message_id.");
    }

    return { externalId: telegramExternalId(creds.botId, chatId, enviada.message_id) };
  },

  /**
   * A conexão está de pé AGORA? `getMe` é a sonda mais barata da Bot API e é a
   * única que responde a pergunta certa: o token ainda vale?
   *
   *   401/404 → token revogado ou bot apagado. FAILED (a falha calada).
   *   rede/timeout → `reachable: false`, sem status: não deu para perguntar,
   *                  e "caiu" seria informação falsa.
   */
  async checkHealth(input: ChannelTenantScope & { sessionRef: string }): Promise<ChannelHealth> {
    const admin = createAdminClient();
    let creds: Awaited<ReturnType<typeof telegramCredsForBotId>>;
    try {
      creds = await telegramCredsForBotId(admin, {
        organizationId: input.organizationId,
        botId: input.sessionRef,
      });
    } catch {
      return { reachable: false, status: null, detail: "credencial_ilegivel" };
    }
    if (!creds) return { reachable: false, status: null, detail: "sem_credencial_para_a_sessao" };

    try {
      await telegramRequest<{ id?: number }>(creds.token, "getMe");
      return { reachable: true, status: "WORKING", detail: null };
    } catch (err) {
      const detalhe = err instanceof Error ? err.message : "erro_desconhecido";
      // 401/404 = o token não vale mais. O resto é transporte.
      if (/\b(401|404)\b/.test(detalhe)) {
        return { reachable: true, status: "FAILED", detail: detalhe.slice(0, 200) };
      }
      return { reachable: false, status: null, detail: detalhe.slice(0, 200) };
    }
  },

  codes: {
    notConfigured: "telegram_not_configured",
    sendFailed: "telegram_error",
    unknownError: "telegram_unknown",
  },
};
