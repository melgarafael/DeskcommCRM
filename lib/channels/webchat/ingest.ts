/**
 * Entrada do chat no site: mensagem do visitante → contato, conversa, mensagem.
 *
 * Molde do bot do Telegram (`lib/channels/bot/ingest.ts`): o contato entra por
 * `contacts.social_identity`, a conversa é endereçada por `provider_conversation_id`
 * (aqui, o id do visitante), e a mensagem é idempotente por `external_id`.
 *
 * ─── O que este canal tem de diferente ─────────────────────────────────────
 *
 * Nada de telefone nem de robô. A identidade é `webchat:<sessão>:<visitante>`:
 * o visitante não tem número, e o id da sessão separa dois sites da mesma
 * organização. O nome nasce como `NOME_DO_VISITANTE` até o visitante dizer o dele.
 *
 * ─── Idempotência ──────────────────────────────────────────────────────────
 *
 * O widget reenvia o que não recebeu resposta. A chave é `unique (organization_id,
 * external_id)` com `23505` lido como "duplicate", não como erro: tratar como erro
 * devolveria 500 e o reenvio nunca pararia. O `external_id` leva a sessão e o
 * visitante, para que o id de um visitante não engula a mensagem de outro.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { marcarConversaComMensagem } from "../marcar-conversa";
import { aplicarEfeitosPosEntrada } from "../pos-entrada";

/** `conversations.channel` e `contacts.source` deste canal. */
export const CANAL_WEBCHAT = "webchat";

/** Nome provisório do contato até o visitante informar o dele. */
export const NOME_DO_VISITANTE = "Visitante do site";

export interface IngerirMensagemDoChatInput {
  organizationId: string;
  channelSessionId: string;
  visitanteId: string;
  mensagemId: string;
  texto: string;
  agora: Date;
}

export interface IngerirMensagemDoChatResult {
  status: "ingested" | "duplicate";
  conversationId: string;
  messageId: string | null;
}

export async function ingerirMensagemDoChat(
  admin: SupabaseClient,
  p: IngerirMensagemDoChatInput,
): Promise<IngerirMensagemDoChatResult> {
  const identity = `webchat:${p.channelSessionId}:${p.visitanteId}`;
  const externalId = `wc:${p.channelSessionId}:${p.visitanteId}:${p.mensagemId}`;

  const contactId = await upsertContact(admin, p.organizationId, identity);
  const conversationId = await upsertConversation(admin, {
    organizationId: p.organizationId,
    contactId,
    channelSessionId: p.channelSessionId,
    visitanteId: p.visitanteId,
  });

  const inserted = await insertMessage(admin, {
    organizationId: p.organizationId,
    conversationId,
    contactId,
    channelSessionId: p.channelSessionId,
    externalId,
    texto: p.texto,
    sentAt: p.agora,
  });
  if (inserted === "duplicate") return { status: "duplicate", conversationId, messageId: null };

  await marcarConversaComMensagem(admin, {
    organizationId: p.organizationId,
    conversationId,
    direction: "inbound",
    preview: p.texto.slice(0, 200),
    at: p.agora.toISOString(),
    canal: CANAL_WEBCHAT,
  });

  await aplicarEfeitosPosEntrada(admin, {
    organizationId: p.organizationId,
    contactId,
    conversationId,
    messageId: inserted,
    channelSessionId: p.channelSessionId,
    texto: p.texto,
    nomeDoContato: NOME_DO_VISITANTE,
    origem: "webchat_widget",
    canal: CANAL_WEBCHAT,
  });

  return { status: "ingested", conversationId, messageId: inserted };
}

/**
 * O contato pela identidade social. O índice único é PARCIAL (`is_merged_into is
 * null`): uma linha fundida e uma viva com a mesma identidade são estado legítimo,
 * por isso a leitura filtra o VIVO.
 */
async function upsertContact(admin: SupabaseClient, organizationId: string, identity: string): Promise<string> {
  const { data: existing, error: readError } = await admin
    .from("contacts")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("social_identity", identity)
    .is("is_merged_into", null)
    .maybeSingle();
  if (readError) throw new Error("webchat_contact_lookup_failed");
  if (existing) return (existing as { id: string }).id;

  const { data, error } = await admin
    .from("contacts")
    .insert({
      organization_id: organizationId,
      social_identity: identity,
      name: NOME_DO_VISITANTE,
      display_name: NOME_DO_VISITANTE,
      source: CANAL_WEBCHAT,
    })
    .select("id")
    .single();

  // 23505 = a mesma pessoa abriu duas mensagens ao mesmo tempo. Quem perdeu a
  // corrida procura o VIVO.
  if (error?.code === "23505") {
    const { data: winner, error: retryError } = await admin
      .from("contacts")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("social_identity", identity)
      .is("is_merged_into", null)
      .single();
    if (retryError || !winner) throw new Error("webchat_contact_race_failed");
    return (winner as { id: string }).id;
  }
  if (error || !data) throw new Error("webchat_contact_create_failed");
  return (data as { id: string }).id;
}

/**
 * A conversa deste visitante, com o canal e o endereço gravados SEMPRE.
 *
 * `fn_upsert_wa_conversation` nasce a linha com `channel = 'whatsapp'`; o canal e
 * o `provider_conversation_id` entram no UPDATE logo depois, sem condição (`neq` em
 * SQL não alcança NULL, e a conversa recém-criada tem a coluna NULL).
 */
async function upsertConversation(
  admin: SupabaseClient,
  input: { organizationId: string; contactId: string; channelSessionId: string; visitanteId: string },
): Promise<string> {
  const { data, error } = await admin.rpc("fn_upsert_wa_conversation" as never, {
    p_org: input.organizationId,
    p_contact: input.contactId,
    p_session: input.channelSessionId,
  } as never);
  if (error || !data) throw new Error("webchat_conversation_upsert_failed");
  const conversationId = data as string;

  const { error: updateError } = await admin
    .from("conversations")
    .update({ channel: CANAL_WEBCHAT, provider_conversation_id: input.visitanteId })
    .eq("organization_id", input.organizationId)
    .eq("id", conversationId);
  if (updateError) {
    throw new Error(`webchat_conversation_update_failed: ${updateError.code ?? ""}`.trim());
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
    externalId: string;
    texto: string;
    sentAt: Date;
  },
): Promise<string | "duplicate"> {
  const { error, data } = await admin
    .from("messages")
    .insert({
      organization_id: input.organizationId,
      conversation_id: input.conversationId,
      contact_id: input.contactId,
      channel_session_id: input.channelSessionId,
      external_id: input.externalId,
      direction: "inbound",
      // Chegou pelo webhook do widget, não pelo composer: o default `'crm'` mentiria.
      // `messages_sent_via_check` não aceita um valor próprio do webchat.
      sent_via: "external_device",
      status: "delivered",
      type: "text",
      body: input.texto,
      sent_at: input.sentAt.toISOString(),
    })
    .select("id")
    .maybeSingle();

  if (error?.code === "23505") return "duplicate";
  if (error || !data) throw new Error(`webchat_ingest_insert_failed: ${error?.message ?? "sem id"}`);
  return (data as { id: string }).id;
}
