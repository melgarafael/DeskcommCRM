/**
 * lib/waha/ingest.ts — pipeline de ingestão WAHA compartilhado pelos dois route
 * handlers de webhook (`/waha` global e `/waha/[token]` per-tenant).
 *
 * Fonte única da verdade para: parse de identidade WhatsApp, resolução de
 * contato/conversa e persistência de mensagem. Resolução é ATÔMICA via RPC
 * (fn_upsert_wa_contact / fn_upsert_wa_conversation) — o padrão check-then-act
 * antigo criava um contato/conversa novo a cada mensagem porque o WAHA NOWEB
 * emite `message` E `message.any` para a mesma mensagem (corrida). Ver migration
 * 0027 para o modelo de identidade canônica.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { audit } from "@/lib/audit";
import type { createAdminClient } from "@/lib/supabase/admin";
import { ackToStatus } from "@/lib/types/messaging";
import { bareWaMessageId } from "@/lib/waha/message-id";

type Admin = ReturnType<typeof createAdminClient>;

interface Session {
  id: string;
  organization_id: string;
}

export interface WahaPayload {
  id?: string;
  from?: string;
  to?: string;
  fromMe?: boolean;
  body?: string;
  type?: string;
  hasMedia?: boolean;
  ack?: number;
  ackName?: string;
  participant?: string;
  author?: string;
  status?: string;
  timestamp?: number;
  mediaUrl?: string;
  mimetype?: string;
  /** WAHA >= 2026.x (NOWEB): mídia vem aninhada em payload.media. */
  media?: { url?: string | null; mimetype?: string | null; filename?: string | null } | null;
  _data?: {
    notifyName?: string;
    pushName?: string;
    /** NOWEB: o conteúdo real (imageMessage, stickerMessage, …) — fonte do tipo. */
    message?: Record<string, unknown>;
  } & Record<string, unknown>;
}

export interface WahaEnvelope {
  event?: string;
  session?: string;
  payload?: WahaPayload;
}

export type ChatIdentity =
  | { kind: "phone"; phone: string; lid: null }
  | { kind: "lid"; phone: null; lid: string } // lid = somente dígitos
  | { kind: "group"; phone: null; lid: null };

/**
 * Resolve um chatId WAHA em identidade canônica:
 *  - `{number}@c.us` | `@s.whatsapp.net` -> phone E.164 ("+55...")
 *  - `{lid}@lid` -> lid (somente dígitos; número protegido pelo WhatsApp)
 *  - `@g.us` | formato desconhecido -> group (skip binding CRM)
 */
export function parseChatId(chatId: string): ChatIdentity {
  if (chatId.endsWith("@g.us")) return { kind: "group", phone: null, lid: null };
  if (chatId.endsWith("@lid")) {
    return { kind: "lid", phone: null, lid: chatId.replace(/@.*$/, "") };
  }
  if (chatId.endsWith("@c.us") || chatId.endsWith("@s.whatsapp.net")) {
    const digits = chatId.replace(/@.*$/, "").replace(/^\+/, "");
    return { kind: "phone", phone: "+" + digits, lid: null };
  }
  return { kind: "group", phone: null, lid: null };
}

const STOP_RX = /\b(STOP|PARAR|SAIR|UNSUBSCRIBE)\b/i;

export function verifyHmacSha512(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): boolean {
  if (!signatureHeader) return false;
  const expected = createHmac("sha512", secret).update(rawBody, "utf8").digest("hex");
  const got = signatureHeader.replace(/^sha512=/i, "").trim();
  if (got.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(got, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

function previewFromMessage(p: WahaPayload): string {
  if (p.body) return p.body.slice(0, 280);
  const t = resolveMessageType(p);
  return t !== "text" ? `[${t}]` : "";
}

/** URL da mídia: WAHA novo (payload.media.url) com fallback legado (payload.mediaUrl). */
export function mediaUrlOf(p: WahaPayload): string | null {
  return p.mediaUrl ?? p.media?.url ?? null;
}

/** MIME da mídia: idem (payload.media.mimetype é o campo do NOWEB atual). */
export function mediaMimeOf(p: WahaPayload): string | null {
  return p.mimetype ?? p.media?.mimetype ?? null;
}

/**
 * Mapeia o `type` cru do WAHA NOWEB para o vocabulário de messages.type do CRM
 * (check constraint messages_type_check). WAHA usa `chat` p/ texto, `ptt` p/
 * áudio de voz, `vcard` p/ contato, etc. Sem esse mapa o INSERT viola a
 * constraint e a mensagem some. O type cru fica em metadata.raw_type.
 */
const WA_TYPE_MAP: Record<string, string> = {
  chat: "text",
  text: "text",
  ptt: "audio",
  audio: "audio",
  image: "image",
  video: "video",
  document: "document",
  sticker: "sticker",
  location: "location",
  vcard: "contact",
  contact: "contact",
  multi_vcard: "contact",
  reaction: "reaction",
};

function mapWahaMessageType(raw: string | undefined): string {
  if (!raw) return "text";
  // Fallback "text": só chegamos ao insert com body/mídia presente (guarda acima),
  // então tratar tipo desconhecido como texto não perde a mensagem.
  return WA_TYPE_MAP[raw.toLowerCase()] ?? "text";
}

/**
 * NOWEB (WAHA 2026.x) não envia `type` no payload — o tipo real está nas
 * chaves de `_data.message` (imageMessage, stickerMessage, …). Ordem de
 * resolução: `type` explícito → chave do message → prefixo do MIME → text.
 */
const NOWEB_MESSAGE_KEY_TYPE: Record<string, string> = {
  stickerMessage: "sticker",
  imageMessage: "image",
  videoMessage: "video",
  ptvMessage: "video", // video note (bolinha)
  audioMessage: "audio",
  documentMessage: "document",
  documentWithCaptionMessage: "document",
};

export function resolveMessageType(p: WahaPayload): string {
  if (p.type) return mapWahaMessageType(p.type);
  const msg = p._data?.message;
  if (msg && typeof msg === "object") {
    for (const [key, mapped] of Object.entries(NOWEB_MESSAGE_KEY_TYPE)) {
      if (key in msg) return mapped;
    }
  }
  const mime = mediaMimeOf(p);
  if (mime) {
    if (mime === "image/webp") return "sticker";
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("video/")) return "video";
    if (mime.startsWith("audio/")) return "audio";
    return "document";
  }
  return "text";
}

function notifyNameOf(p: WahaPayload): string | null {
  return p._data?.notifyName ?? p._data?.pushName ?? null;
}

/**
 * Upsert atômico de contato pela identidade canônica. Retorna null se a
 * identidade for de grupo ou a RPC falhar.
 */
async function upsertContact(
  admin: Admin,
  orgId: string,
  parsed: ChatIdentity,
  chatId: string,
  notifyName: string | null,
): Promise<string | null> {
  if (parsed.kind === "group") return null;
  const { data, error } = await admin.rpc("fn_upsert_wa_contact" as never, {
    p_org: orgId,
    p_kind: parsed.kind,
    p_phone: parsed.kind === "phone" ? parsed.phone : null,
    p_lid: parsed.kind === "lid" ? parsed.lid : null,
    p_chat_id: chatId,
    p_notify: notifyName,
  } as never);
  if (error) {
    console.error("[waha.ingest] fn_upsert_wa_contact failed", error.message);
    return null;
  }
  return (data as string) ?? null;
}

async function upsertConversation(
  admin: Admin,
  orgId: string,
  contactId: string,
  sessionId: string,
): Promise<string | null> {
  const { data, error } = await admin.rpc("fn_upsert_wa_conversation" as never, {
    p_org: orgId,
    p_contact: contactId,
    p_session: sessionId,
  } as never);
  if (error) {
    console.error("[waha.ingest] fn_upsert_wa_conversation failed", error.message);
    return null;
  }
  return (data as string) ?? null;
}

async function markConversation(
  admin: Admin,
  convId: string,
  direction: "inbound" | "outbound",
  preview: string,
  at: string,
): Promise<void> {
  const { error } = await admin.rpc("fn_mark_conversation_message" as never, {
    p_conv: convId,
    p_direction: direction,
    p_preview: preview,
    p_at: at,
  } as never);
  if (error) console.error("[waha.ingest] fn_mark_conversation_message failed", error.message);
}

/**
 * Mensagem recebida (fromMe=false). Contato = remetente (`from`).
 */
async function handleInbound(
  admin: Admin,
  session: Session,
  p: WahaPayload,
  requestId: string,
): Promise<void> {
  const chatId = p.from ?? "";
  const parsed = parseChatId(chatId);
  if (parsed.kind === "group") return; // grupos não fazem binding CRM
  if (!p.id || !chatId) return;
  // WAHA emite eventos vazios p/ status/read-receipt/presence — não viram mensagem.
  if (!p.body && !mediaUrlOf(p) && !p.hasMedia) return;

  const contactId = await upsertContact(admin, session.organization_id, parsed, chatId, notifyNameOf(p));
  if (!contactId) return;
  const conversationId = await upsertConversation(admin, session.organization_id, contactId, session.id);
  if (!conversationId) return;

  const now = new Date().toISOString();
  const { data: insertedMessage, error: insertErr } = await admin
    .from("messages")
    .insert({
      organization_id: session.organization_id,
      conversation_id: conversationId,
      channel_session_id: session.id,
      contact_id: contactId,
      external_id: p.id,
      type: resolveMessageType(p),
      direction: "inbound",
      status: "delivered",
      ack: p.ack ?? null,
      body: p.body ?? null,
      media_url: mediaUrlOf(p),
      media_mime: mediaMimeOf(p),
      sent_via: "external_device",
      sent_at: p.timestamp ? new Date(p.timestamp * 1000).toISOString() : now,
      delivered_at: now,
      metadata: { raw_type: p.type, ack_name: p.ackName },
    })
    .select("id")
    .maybeSingle();

  // Idempotência: 23505 = unique (organization_id, external_id) já ingerido.
  if (insertErr && insertErr.code !== "23505") {
    console.error("[waha.ingest] message insert failed", insertErr.message);
    return;
  }
  if (insertErr?.code === "23505") return;

  await markConversation(admin, conversationId, "inbound", previewFromMessage(p), now);

  if (p.body && STOP_RX.test(p.body)) {
    await admin
      .from("contacts")
      .update({ is_blocked: true, blocked_reason: "stop_keyword", blocked_at: now })
      .eq("id", contactId);
    await audit({
      action: "contact.blocked",
      organizationId: session.organization_id,
      resourceType: "contact",
      requestId,
      metadata: { reason: "stop_keyword", contact_id: contactId },
    });
  }

  await audit({
    action: "message.received",
    organizationId: session.organization_id,
    resourceType: "message",
    requestId,
    metadata: { conversation_id: conversationId, type: p.type, external_id: p.id },
  });

  // Dispara o agent-dispatcher worker (fire-and-forget; falha não quebra o 200).
  if (insertedMessage?.id) {
    const inboundMessageId = insertedMessage.id;
    admin
      .rpc("emit_event" as never, {
        p_event_type: "ai_agent.dispatch_requested",
        p_entity_kind: "message",
        p_entity_id: inboundMessageId,
        p_payload: {
          organization_id: session.organization_id,
          conversation_id: conversationId,
          contact_id: contactId,
          channel_session_id: session.id,
          inbound_message_id: inboundMessageId,
        },
        p_metadata: { source: "waha_webhook", request_id: requestId },
        p_organization_id: session.organization_id,
      } as never)
      .then(({ error }) => {
        if (error) console.error("[waha.ingest] emit dispatch_requested failed", error.message);
      });

    admin
      .rpc("emit_event" as never, {
        p_event_type: "message.received",
        p_entity_kind: "message",
        p_entity_id: inboundMessageId,
        p_payload: {
          conversation_id: conversationId,
          contact_id: contactId,
          channel_session_id: session.id,
          body_preview: (p.body ?? "").slice(0, 280),
        },
        p_metadata: { source: "waha_webhook", request_id: requestId },
        p_organization_id: session.organization_id,
      } as never)
      .then(({ error }) => {
        if (error) console.error("[waha.ingest] emit message.received failed", error.message);
      });

    if (mediaUrlOf(p)) {
      admin
        .rpc("emit_event" as never, {
          p_event_type: "media.persist_requested",
          p_entity_kind: "message",
          p_entity_id: inboundMessageId,
          p_payload: { message_id: inboundMessageId, conversation_id: conversationId },
          p_metadata: { source: "waha_webhook", request_id: requestId },
          p_organization_id: session.organization_id,
        } as never)
        .then(({ error }) => {
          if (error) console.error("[waha.ingest] emit media.persist_requested failed", error.message);
        });
    }
  }
}

/**
 * fromMe=true: operador respondeu direto do WhatsApp dele (não pelo composer).
 * Contato = destinatário (`to`). `from` é o próprio número do operador — nunca
 * vira contato. Registrado como outbound p/ o operador ver o histórico completo.
 */
async function handleOutboundFromUserPhone(
  admin: Admin,
  session: Session,
  p: WahaPayload,
  requestId: string,
): Promise<void> {
  const chatId = p.to ?? "";
  const parsed = parseChatId(chatId);
  if (parsed.kind === "group") return;
  if (!p.id || !chatId) return;
  if (!p.body && !mediaUrlOf(p) && !p.hasMedia) return;

  const contactId = await upsertContact(admin, session.organization_id, parsed, chatId, notifyNameOf(p));
  if (!contactId) return;
  const conversationId = await upsertConversation(admin, session.organization_id, contactId, session.id);
  if (!conversationId) return;

  const now = new Date().toISOString();
  const { data: insertedOutbound, error: insertErr } = await admin
    .from("messages")
    .insert({
      organization_id: session.organization_id,
      conversation_id: conversationId,
      channel_session_id: session.id,
      contact_id: contactId,
      external_id: p.id,
      type: resolveMessageType(p),
      direction: "outbound",
      status: "sent",
      ack: p.ack ?? null,
      body: p.body ?? null,
      media_url: mediaUrlOf(p),
      media_mime: mediaMimeOf(p),
      sent_via: "external_device",
      sent_at: p.timestamp ? new Date(p.timestamp * 1000).toISOString() : now,
      metadata: { raw_type: p.type, fromMe: true },
    })
    .select("id")
    .maybeSingle();
  if (insertErr && insertErr.code !== "23505") {
    console.error("[waha.ingest] outbound insert failed", insertErr.message);
    return;
  }
  if (insertErr?.code === "23505") return;

  await markConversation(admin, conversationId, "outbound", previewFromMessage(p), now);

  await audit({
    action: "message.sent",
    organizationId: session.organization_id,
    resourceType: "message",
    requestId,
    metadata: { conversation_id: conversationId, type: p.type, external_id: p.id, from_user_phone: true },
  });

  if (insertedOutbound?.id && mediaUrlOf(p)) {
    admin
      .rpc("emit_event" as never, {
        p_event_type: "media.persist_requested",
        p_entity_kind: "message",
        p_entity_id: insertedOutbound.id,
        p_payload: { message_id: insertedOutbound.id, conversation_id: conversationId },
        p_metadata: { source: "waha_webhook", request_id: requestId },
        p_organization_id: session.organization_id,
      } as never)
      .then(({ error }) => {
        if (error) console.error("[waha.ingest] emit media.persist_requested failed", error.message);
      });
  }
}

async function handleAck(admin: Admin, session: Session, p: WahaPayload): Promise<void> {
  if (!p.id) return;
  const ack = p.ack ?? 0;
  const status = ackToStatus(ack);
  const now = new Date().toISOString();

  const update: Record<string, unknown> = { ack, status };
  if (ack >= 2) update.delivered_at = now;
  if (ack >= 3) update.read_at = now;

  // O ack do WAHA 2026.x vem como `{fromMe}_{chatId}_{bareId}`, mas o envio
  // gravou `external_id` = bareId. Normaliza p/ a cauda antes de casar.
  await admin
    .from("messages")
    .update(update)
    .eq("organization_id", session.organization_id)
    .eq("external_id", bareWaMessageId(p.id));
}

interface SessionStatusRow extends Session {
  is_warmup_complete: boolean | null;
  warmup_started_at: string | null;
}

async function handleSessionStatus(
  admin: Admin,
  session: SessionStatusRow,
  p: WahaPayload,
): Promise<void> {
  const status = (p.status ?? "").toUpperCase() || null;
  if (!status) return;
  const allowed = new Set(["STARTING", "SCAN_QR_CODE", "WORKING", "STOPPED", "FAILED"]);
  if (!allowed.has(status)) return;
  const now = new Date().toISOString();

  const update: Record<string, unknown> = { status, last_status_change_at: now };
  if (status === "WORKING" && session.warmup_started_at && !session.is_warmup_complete) {
    update.is_warmup_complete = true;
    update.warmup_completed_at = now;
  }
  await admin.from("channel_sessions").update(update).eq("id", session.id);
}

/**
 * Roteador único de eventos WAHA. Os dois route handlers convergem aqui após
 * resolver a sessão e validar HMAC.
 */
export async function dispatchWahaEvent(
  admin: Admin,
  session: SessionStatusRow,
  envelope: WahaEnvelope,
  requestId: string,
): Promise<void> {
  const eventType = envelope.event ?? "unknown";
  const payload = envelope.payload ?? {};

  if (eventType === "message" || eventType === "message.any") {
    if (payload.fromMe) {
      await handleOutboundFromUserPhone(admin, session, payload, requestId);
    } else {
      await handleInbound(admin, session, payload, requestId);
    }
  } else if (eventType === "message.ack") {
    await handleAck(admin, session, payload);
  } else if (eventType === "session.status" || eventType === "state.change") {
    await handleSessionStatus(admin, session, payload);
  }
}
