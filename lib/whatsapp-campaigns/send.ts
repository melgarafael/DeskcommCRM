/**
 * Envio de campanha via o sink canônico `sendMessageHandler`.
 *
 * Idempotência (camada campanha + messages):
 * - `outbound_message_id` → `ctx.internalMessageId` (PK fixa em messages).
 * - Se a message já está sent/delivered/read com external_id → NÃO chama WAHA
 *   de novo (reconcile Scenario B).
 * - Se está failed → o claim SQL já rotacionou o UUID (senão 23505 devolveria
 *   failed sem reenvio — bug).
 * - Se está queued sem external_id → sendMessageHandler continua até WAHA
 *   (Scenario A). Timeout ambíguo → send_uncertain no worker (não aqui).
 *
 * Semântica adotada no limite DB→WAHA: **at-least-once preferencial com
 * freio at-most-once em ambiguidade** (ver classifySendError / worker-tick).
 * WAHA `/api/sendText` (tag latest-2026.7.2) NÃO documenta idempotency key /
 * clientMessageId — medido na doc oficial send-messages.
 */
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { HandlerCtx } from "@/lib/api/handlers/types";
import { ensureConversation } from "@/lib/automation/start-conversation";
import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import type { Message } from "@/lib/types/messaging";

const PROVIDER_ACCEPTED = new Set(["sent", "delivered", "read"]);

export async function lookupOutboundMessage(
  admin: SupabaseClient,
  organizationId: string,
  outboundMessageId: string,
): Promise<Message | null> {
  const { data } = await admin
    .from("messages")
    .select(
      "id, organization_id, conversation_id, channel_session_id, contact_id, external_id, type, direction, status, ack, error_code, error_message, body, media_url, media_mime, media_size_bytes, media_storage_path, sent_via, sent_by_user_id, sent_at, delivered_at, read_at, metadata, edited_at, deleted_at, reply_to_message_id, created_at",
    )
    .eq("organization_id", organizationId)
    .eq("id", outboundMessageId)
    .maybeSingle();
  return (data as Message | null) ?? null;
}

/** Message já aceita pelo provider — reconcile sem segundo send. */
export function isProviderAccepted(msg: Message): boolean {
  return PROVIDER_ACCEPTED.has(msg.status) && Boolean(msg.external_id);
}

export async function sendCampaignMessage(opts: {
  admin: SupabaseClient;
  organizationId: string;
  contactId: string;
  channelSessionId: string;
  body: string;
  outboundMessageId: string;
  campaignId: string;
  recipientId: string;
}): Promise<Message> {
  const existing = await lookupOutboundMessage(
    opts.admin,
    opts.organizationId,
    opts.outboundMessageId,
  );
  if (existing && isProviderAccepted(existing)) {
    return existing;
  }

  const conversationId = await ensureConversation(
    opts.admin,
    opts.organizationId,
    opts.contactId,
    opts.channelSessionId,
  );

  const ctx: HandlerCtx = {
    organization_id: opts.organizationId,
    actor: {
      type: "ai_agent",
      id: `whatsapp-campaign:${opts.campaignId}`,
      role: "system",
      agent_id: undefined,
    },
    requestId: randomUUID(),
    internalMessageId: opts.outboundMessageId,
  };

  return sendMessageHandler(opts.admin, ctx, {
    conversation_id: conversationId,
    type: "text",
    body: opts.body,
    metadata: {
      source: "whatsapp_campaign",
      campaign_id: opts.campaignId,
      recipient_id: opts.recipientId,
    },
  });
}
