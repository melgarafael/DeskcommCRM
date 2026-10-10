/**
 * Ingestão de comentários Instagram.
 *
 * Recebe eventos parseados pelo `comment-parser.ts`, grava em
 * `ig_comment_events` (idempotente via unique index) e emite entrada
 * no `event_log` para o worker de automação processar.
 *
 * NUNCA faz HTTP dentro desta função — é chamada dentro de um handler
 * de webhook, e o worker é quem executa os side effects (enviar DM,
 * responder comentário). Segue a doutrina CLAUDE.md: trigger ≠ HTTP.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "@/lib/logger";
import type { IgCommentEvent } from "./comment-parser";

export interface IngestIgCommentInput {
  organizationId: string;
  channelSessionId: string | null;
  event: IgCommentEvent;
  payloadRaw: Record<string, unknown>;
}

export interface IngestIgCommentResult {
  status: "inserted" | "duplicate" | "error";
  commentEventId?: string;
  reason?: string;
}

/**
 * Grava o comentário em `ig_comment_events` e emite evento no `event_log`.
 *
 * Idempotente: reentrega do webhook retorna `status: "duplicate"` sem
 * emitir segundo evento.
 *
 * `db` deve ser um client com service_role (bypass RLS) — a validação
 * de tenant já foi feita pelo handler via fn_ig_webhook_token_por_path.
 */
export async function ingestIgComment(
  db: SupabaseClient,
  input: IngestIgCommentInput,
): Promise<IngestIgCommentResult> {
  const { organizationId, channelSessionId, event, payloadRaw } = input;

  // 1. Gravar o comentário (idempotente pelo unique index)
  const { data: inserted, error: insertError } = await db
    .from("ig_comment_events")
    .insert({
      organization_id: organizationId,
      channel_session_id: channelSessionId,
      instagram_comment_id: event.commentId,
      instagram_post_id: event.mediaId,       // post = media
      instagram_media_id: event.mediaId,
      from_instagram_id: event.fromId,
      from_username: event.fromUsername,
      texto: event.texto,
      payload_raw: payloadRaw,
      processado: false,
    })
    .select("id")
    .single();

  if (insertError) {
    // Unique violation → duplicate delivery
    if (insertError.code === "23505") {
      return { status: "duplicate" };
    }
    logger.error("[ig-comment-ingest] insert error", {
      organizationId,
      commentId: event.commentId,
      error: insertError.message,
    });
    return { status: "error", reason: insertError.message };
  }

  const commentEventId = inserted.id as string;

  // 2. Emitir evento no event_log para o worker de automação
  // O worker consome 'ig.comment_received' e avalia as automations flows.
  // NUNCA fazemos HTTP aqui — apenas escrevemos no banco.
  const { error: logError } = await db.from("event_log").insert({
    organization_id: organizationId,
    event_type: "ig.comment_received",
    entity_kind: "ig_comment_events",
    entity_id: commentEventId,
    payload: {
      comment_id: event.commentId,
      from_id: event.fromId,
      from_username: event.fromUsername,
      texto: event.texto,
      media_id: event.mediaId,
      channel_session_id: channelSessionId,
      field: event.field,
    },
  });

  if (logError) {
    logger.error("[ig-comment-ingest] event_log insert error", {
      organizationId,
      commentEventId,
      error: logError.message,
    });
    // Não falha o ingest — o comentário já foi salvo.
    // O comentário pode ser reprocessado via retry manual se necessário.
    return {
      status: "inserted",
      commentEventId,
      reason: `event_log_error:${logError.message}`,
    };
  }

  return { status: "inserted", commentEventId };
}
