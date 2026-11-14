/**
 * Entrada do bot do Telegram: update → contato, conversa, mensagem.
 *
 * A leitura do corpo é do módulo puro ao lado (`./webhook.ts`); aqui moram os
 * EFEITOS — mesma divisão do canal intermediado, pelo mesmo motivo: o que
 * decide dá para provar sem banco.
 *
 * ─── O que este canal tem de diferente dos outros dois ─────────────────────
 *
 * Nada de telefone. O contato entra por `contacts.social_identity` no molde da
 * 0368 (`telegram:<robô>:<usuário>`) e a conversa é endereçada pelo `chat_id`,
 * que é `conversations.provider_conversation_id` — porque, como no canal
 * social, o endereço NÃO se deriva do contato: é um id que a plataforma
 * entrega. Sem gravar a thread, a mensagem aparece e o operador não consegue
 * responder.
 *
 * ─── Idempotência ──────────────────────────────────────────────────────────
 *
 * O Telegram reentrega o que não recebe 200 — e é a mesma mensagem. A chave é
 * `unique (organization_id, external_id)` no INSERT, com o `23505` lido como
 * "duplicate" e não como erro: tratar como erro devolveria 500 e ele
 * reentregaria para sempre.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ehCanalDeConversa } from "@/lib/channels/canais-de-conversa";
import { logger } from "@/lib/logger";

import { ARCHIVED_AT, queryTolerantToMissingArchived } from "../archived";
import { marcarConversaComMensagem } from "../marcar-conversa";
import { aplicarEfeitosPosEntrada } from "../pos-entrada";
import { readTelegramUpdate, telegramIdentity, type TelegramInbound } from "./webhook";

/** `conversations.channel` deste canal. Ver `CANAIS_DE_CONVERSA`. */
export const CANAL_TELEGRAM = "telegram";

export interface TelegramIngestResult {
  status: "ingested" | "duplicate" | "ignored";
  conversationId?: string;
  messageId?: string;
  reason?: string;
}

export async function ingestTelegramInbound(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    channelSessionId: string;
    payload: unknown;
  },
): Promise<TelegramIngestResult> {
  // ─── A sessão é quem diz de qual robô é este update ──────────────────────
  //
  // O `bot_id` entra no `external_id` e na `social_identity`, então ele NÃO
  // pode vir do corpo: quem manda no webhook escolheria a identidade do
  // contato. Vem da linha que o token do caminho resolveu, conferida aqui de
  // novo (provider + organização) para o caso de alguém chamar este módulo por
  // outro caminho.
  const base = () =>
    admin
      .from("channel_sessions")
      .select("telegram_bot_id, provider")
      .eq("organization_id", input.organizationId)
      .eq("id", input.channelSessionId);
  const { data: sessao, error } = await queryTolerantToMissingArchived(
    () => base().is(ARCHIVED_AT, null).maybeSingle(),
    () => base().maybeSingle(),
  );
  if (error) throw new Error("telegram_session_lookup_failed");
  const row = sessao as { telegram_bot_id?: string | null; provider?: string | null } | null;
  const botId = row?.telegram_bot_id ?? null;
  if (!row || row.provider !== "telegram" || !botId) {
    return { status: "ignored", reason: "canal_desconhecido" };
  }

  const leitura = readTelegramUpdate(input.payload, botId);
  if (!leitura.ok) return { status: "ignored", reason: leitura.detalhe };
  const msg = leitura.update;

  // A coluna tem CHECK. Num clone cujo banco ainda não conhece este canal, o
  // UPDATE volta 23514 — e o Telegram REENTREGA o webhook, transformando isso
  // num 500 eterno com a tela mostrando a conexão ligada. Recusar aqui troca o
  // laço por uma linha de log que diz o que falta.
  if (!ehCanalDeConversa(CANAL_TELEGRAM)) {
    logger.error("telegram: canal sem valor correspondente no banco — conversa não atualizada", {
      organization_id: input.organizationId,
      detalhe: "falta o valor no CHECK de conversations.channel (migration)",
    });
    return { status: "ignored", reason: "canal_desconhecido" };
  }

  const identity = telegramIdentity(botId, msg.userId);
  const contactId = await upsertContact(admin, input.organizationId, identity, msg.displayName);
  const conversationId = await upsertConversation(admin, {
    organizationId: input.organizationId,
    contactId,
    channelSessionId: input.channelSessionId,
    chatId: msg.chatId,
  });

  const inserted = await insertMessage(admin, {
    organizationId: input.organizationId,
    conversationId,
    contactId,
    channelSessionId: input.channelSessionId,
    msg,
  });
  if (inserted === "duplicate") return { status: "duplicate", conversationId };

  await marcarConversaComMensagem(admin, {
    organizationId: input.organizationId,
    conversationId,
    direction: "inbound",
    preview: msg.text.slice(0, 200),
    // A hora em que o cliente ESCREVEU, não a da chegada do webhook: numa
    // reentrega atrasada as duas diferem por horas, e `last_inbound_at` é a
    // fonte da janela de atendimento.
    at: msg.sentAt,
    canal: CANAL_TELEGRAM,
  });

  await aplicarEfeitosPosEntrada(admin, {
    organizationId: input.organizationId,
    contactId,
    conversationId,
    messageId: inserted,
    channelSessionId: input.channelSessionId,
    texto: msg.text,
    nomeDoContato: msg.displayName,
    origem: "telegram_webhook",
    // Sem isto o negócio que nasce desta conversa entra como `whatsapp` e todo
    // relatório por canal o conta no lugar errado.
    canal: CANAL_TELEGRAM,
  });

  return { status: "ingested", conversationId, messageId: inserted };
}

/**
 * O contato pela identidade social — mesmo molde da 0368.
 *
 * O índice único é PARCIAL (`where social_identity is not null and is_merged_into
 * is null`), então duas linhas com a mesma identidade — uma fundida, uma viva —
 * são estado legítimo; sem o filtro o `.maybeSingle()` estoura com duas.
 */
async function upsertContact(
  admin: SupabaseClient,
  organizationId: string,
  identity: string,
  name: string | null,
): Promise<string> {
  const { data: existing, error: readError } = await admin
    .from("contacts")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("social_identity", identity)
    .is("is_merged_into", null)
    .maybeSingle();
  if (readError) throw new Error("telegram_contact_lookup_failed");
  if (existing) return (existing as { id: string }).id;

  const { data, error } = await admin
    .from("contacts")
    .insert({
      organization_id: organizationId,
      social_identity: identity,
      name,
      display_name: name,
      source: "telegram",
    })
    .select("id")
    .single();

  // 23505 = alguém criou o mesmo contato entre a leitura e o INSERT (dois
  // updates simultâneos da mesma pessoa). Quem perdeu a corrida procura o VIVO.
  if (error?.code === "23505") {
    const { data: winner, error: retryError } = await admin
      .from("contacts")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("social_identity", identity)
      .is("is_merged_into", null)
      .single();
    if (retryError || !winner) throw new Error("telegram_contact_race_failed");
    return (winner as { id: string }).id;
  }
  if (error || !data) throw new Error("telegram_contact_create_failed");
  return (data as { id: string }).id;
}

/**
 * A conversa desta pessoa neste robô, com o canal e a thread gravados SEMPRE.
 *
 * `fn_upsert_wa_conversation` nasce a linha com `channel = 'whatsapp'` (é a RPC
 * do canal por QR, reusada para não inventar um segundo upsert onde a mesma
 * corrida pode voltar). O canal e o `chat_id` entram no UPDATE logo depois — sem
 * condição, como o irmão intermediado aprendeu: `neq` em SQL não alcança NULL, e
 * a conversa recém-criada tem a coluna NULL.
 */
async function upsertConversation(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    contactId: string;
    channelSessionId: string;
    chatId: string;
  },
): Promise<string> {
  const { data, error } = await admin.rpc("fn_upsert_wa_conversation" as never, {
    p_org: input.organizationId,
    p_contact: input.contactId,
    p_session: input.channelSessionId,
  } as never);
  if (error || !data) throw new Error("telegram_conversation_upsert_failed");
  const conversationId = data as string;

  const { error: updateError } = await admin
    .from("conversations")
    .update({ channel: CANAL_TELEGRAM, provider_conversation_id: input.chatId })
    .eq("organization_id", input.organizationId)
    .eq("id", conversationId);
  if (updateError) {
    // 23514 aqui é o clone sem o valor no CHECK — a guarda acima já leu o
    // módulo, então esta mensagem é diagnóstico, não desfecho esperado.
    throw new Error(`telegram_conversation_update_failed: ${updateError.code ?? ""}`.trim());
  }

  return conversationId;
}

async function insertMessage(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    conversationId: string;
    contactId: string;
    channelSessionId: string;
    msg: TelegramInbound;
  },
): Promise<string | "duplicate"> {
  const { error, data } = await admin
    .from("messages")
    .insert({
      organization_id: input.organizationId,
      conversation_id: input.conversationId,
      contact_id: input.contactId,
      channel_session_id: input.channelSessionId,
      external_id: input.msg.externalId,
      direction: "inbound",
      // Quem passou por este arquivo chegou pelo webhook, não pelo composer —
      // o default da coluna é `'crm'` e mentiria aqui.
      sent_via: "external_device",
      status: "delivered",
      type: "text",
      body: input.msg.text,
      metadata: { telegram_chat_id: input.msg.chatId, telegram_user_id: input.msg.userId },
      sent_at: input.msg.sentAt,
    })
    .select("id")
    .maybeSingle();

  if (error?.code === "23505") return "duplicate";
  if (error || !data) throw new Error(`telegram_ingest_insert_failed: ${error?.message ?? "sem id"}`);
  return (data as { id: string }).id;
}
