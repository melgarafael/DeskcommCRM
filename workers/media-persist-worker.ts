/**
 * Consome `media.persist_requested`: baixa o binário da mídia (MediaSource
 * WAHA) e persiste no bucket privado `whatsapp-media`, preenchendo
 * media_storage_path/media_size_bytes na linha de `messages`.
 * Retry com backoff linear via HandlerResult (até 5 tentativas), depois
 * marca metadata.media_status = "failed" (Onda 3 poderá reprocessar).
 */
import type { EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { storagePathFor } from "@/lib/messaging/media/types";
import { fetchWahaMedia } from "@/lib/messaging/media/waha-source";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const MEDIA_PERSIST_CONSUMER_KEY = "media_persist_v1";
const MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 60_000;

interface MessageMediaRow {
  id: string;
  organization_id: string;
  conversation_id: string;
  media_url: string | null;
  media_mime: string | null;
  media_storage_path: string | null;
  metadata: Record<string, unknown> | null;
}

export async function persistMessageMedia(row: EventRow): Promise<HandlerResult> {
  const consumer_key = MEDIA_PERSIST_CONSUMER_KEY;
  const messageId = (row.payload.message_id as string | undefined) ?? row.entity_id;
  if (!messageId) return { consumer_key, status: "skipped", detail: "no message_id" };

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("messages")
    .select("id, organization_id, conversation_id, media_url, media_mime, media_storage_path, metadata")
    .eq("id", messageId)
    .eq("organization_id", row.organization_id)
    .maybeSingle();
  if (error) return { consumer_key, status: "error", detail: error.message };

  const msg = data as MessageMediaRow | null;
  if (!msg?.media_url) return { consumer_key, status: "skipped", detail: "no media_url" };
  if (msg.media_storage_path) return { consumer_key, status: "skipped", detail: "already stored" };

  const markStatus = async (media_status: "stored" | "failed", patch: Record<string, unknown> = {}) => {
    const { error: updErr } = await admin
      .from("messages")
      .update({ metadata: { ...(msg.metadata ?? {}), media_status }, ...patch })
      .eq("id", msg.id)
      .eq("organization_id", msg.organization_id);
    if (updErr) throw new Error(`message update failed: ${updErr.message}`);
  };

  let media;
  try {
    media = await fetchWahaMedia(msg.media_url, msg.media_mime);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (row.attempts < MAX_ATTEMPTS) {
      return {
        consumer_key,
        status: "retry",
        retry_at: new Date(Date.now() + RETRY_BASE_MS * (row.attempts + 1)).toISOString(),
        detail,
      };
    }
    logger.error("[media-persist] download failed permanently", { message_id: msg.id, detail });
    await markStatus("failed");
    return { consumer_key, status: "error", detail };
  }

  const path = storagePathFor(msg.organization_id, msg.conversation_id, msg.id, media.mime);
  const { error: uploadErr } = await admin.storage
    .from("whatsapp-media")
    .upload(path, media.buffer, { contentType: media.mime, upsert: true });
  if (uploadErr) return { consumer_key, status: "error", detail: uploadErr.message };

  await markStatus("stored", {
    media_storage_path: path,
    media_size_bytes: media.buffer.byteLength,
    media_mime: media.mime,
  });
  return { consumer_key, status: "ok" };
}
