/**
 * Consome `media.persist_requested`: baixa o binário da mídia (MediaSource
 * WAHA) e persiste no bucket privado `whatsapp-media`, preenchendo
 * media_storage_path/media_size_bytes na linha de `messages`.
 * Retry/backoff é responsabilidade do drain (`lib/event-log/drain.ts`), não
 * deste handler: aqui só retornamos `status:"error"` em falha. O drain conta
 * `attempts` e dead-letra a partir do próprio `MAX_ATTEMPTS`; espelhamos esse
 * valor localmente (`DRAIN_MAX_ATTEMPTS`) só para saber quando é a ÚLTIMA
 * tentativa que o drain vai permitir e marcar `metadata.media_status =
 * "failed"` na própria mensagem antes do dead-letter (Onda 3 poderá
 * reprocessar).
 */
import type { EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import {
  CHANNEL_SESSION_REF_COLUMNS,
  DEFAULT_CHANNEL_PROVIDER,
  getAdapter,
  resolveSessionRef,
  type ChannelProvider,
  type ChannelSessionRef,
} from "@/lib/channels";
import { storagePathFor } from "@/lib/messaging/media/types";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const MEDIA_PERSIST_CONSUMER_KEY = "media_persist_v1";
// Espelha MAX_ATTEMPTS de lib/event-log/drain.ts (não exportado de lá).
// `row.attempts` chega ao handler como a contagem ANTES do incremento do
// drain; o drain dead-letra quando `row.attempts + 1 >= DRAIN_MAX_ATTEMPTS`,
// ou seja, a última tentativa que o drain ainda vai permitir é
// `row.attempts === DRAIN_MAX_ATTEMPTS - 1`.
const DRAIN_MAX_ATTEMPTS = 5;

interface MessageMediaRow {
  channel_session_id: string;
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
    // `channel_session_id` entra no select porque é ele que resolve QUEM baixa.
    // Sem a coluna, o worker não tem como pedir o adapter e voltaria a
    // depender de uma função fixa de um canal só.
    .select(
      "id, organization_id, conversation_id, channel_session_id, media_url, media_mime, media_storage_path, metadata",
    )
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

  const isLastAttempt = row.attempts >= DRAIN_MAX_ATTEMPTS - 1;

  let media;
  try {
    // Pelo ADAPTER, não por uma função fixa. Antes esta linha era
    // `fetchWahaMedia(...)` direto: mídia recebida por qualquer outro canal
    // virava linha SEM bytes, e o atendente via "imagem" sem imagem. Medido em
    // produção: 423 persistências no canal por QR, ZERO no intermediado.
    //
    // O worker não pergunta QUAL canal é — o invariante 1 proíbe e o
    // `lint:channels` reprova. Ele pede a sessão, pede o adapter e testa a
    // presença do método.
    const { data: sessao } = await admin
      .from("channel_sessions")
      .select(`provider, ${CHANNEL_SESSION_REF_COLUMNS}`)
      .eq("organization_id", msg.organization_id)
      .eq("id", msg.channel_session_id)
      .maybeSingle();

    const adapter = getAdapter(
      ((sessao?.provider as string) ?? DEFAULT_CHANNEL_PROVIDER) as ChannelProvider,
    );
    const sessionRef = sessao ? resolveSessionRef(sessao as unknown as ChannelSessionRef) : null;
    if (!adapter.fetchInboundMedia || !sessionRef) {
      // Canal que não sabe baixar não é erro: é o estado normal de um canal sem
      // mídia de entrada. Marcar `failed` faria a Central acusar um defeito que
      // não existe.
      return { consumer_key, status: "skipped", detail: "canal_sem_midia_de_entrada" };
    }

    media = await adapter.fetchInboundMedia({
      organizationId: msg.organization_id,
      sessionRef,
      url: msg.media_url,
      hintMime: msg.media_mime,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (isLastAttempt) {
      logger.error("[media-persist] download failed permanently", { message_id: msg.id, detail });
      await markStatus("failed");
    }
    return { consumer_key, status: "error", detail };
  }

  const path = storagePathFor(msg.organization_id, msg.conversation_id, msg.id, media.mime);
  const { error: uploadErr } = await admin.storage
    .from("whatsapp-media")
    .upload(path, media.buffer, { contentType: media.mime, upsert: true });
  if (uploadErr) {
    if (isLastAttempt) {
      logger.error("[media-persist] upload failed permanently", {
        message_id: msg.id,
        detail: uploadErr.message,
      });
      await markStatus("failed");
    }
    return { consumer_key, status: "error", detail: uploadErr.message };
  }

  await markStatus("stored", {
    media_storage_path: path,
    media_size_bytes: media.buffer.byteLength,
    media_mime: media.mime,
  });

  // Grupo nunca é derivado: a IA não serve grupos, e derivar custaria visão/
  // transcrição PAGA sem consumidor nenhum do outro lado — ninguém leria "o
  // agente não conseguiu ler o que o cliente mandou" numa conversa que a IA
  // nunca participa. A mídia FICA persistida (Storage, para quem abrir a
  // conversa na tela); só a derivação é pulada.
  const { data: conv, error: convErr } = await admin
    .from("conversations")
    .select("is_group")
    .eq("id", msg.conversation_id)
    .eq("organization_id", msg.organization_id)
    .maybeSingle();
  if (convErr) {
    // Fecha FECHADO, não aberto: sem saber se a conversa é de grupo, o erro
    // caro é pedir uma derivação PAGA (visão/transcrição) por engano numa
    // conversa de grupo — não pedir e alguém reprocessar à mão depois é o
    // lado barato de errar. A mídia já está `stored`; só a derivação fica de
    // fora desta rodada.
    logger.warn("[media-persist] leitura de conversations.is_group falhou — derivação NÃO pedida", {
      organization_id: msg.organization_id,
      conversation_id: msg.conversation_id,
      detail: convErr.message,
    });
    return { consumer_key, status: "ok" };
  }
  const isGroup = Boolean((conv as { is_group?: boolean | null } | null)?.is_group);

  if (!isGroup) {
    // Dispara a derivação textual (Onda 3) — fire-and-forget, mesmo padrão do
    // resto do repo: falha de emit não reverte a persistência já concluída.
    const { error: emitErr } = await admin.rpc("emit_event" as never, {
      p_event_type: "media.derive_requested",
      p_entity_kind: "message",
      p_entity_id: msg.id,
      p_payload: { message_id: msg.id },
      p_metadata: { source: "media_persist" },
      p_organization_id: msg.organization_id,
    } as never);
    if (emitErr) logger.warn("[media-persist] emit_event failed (non-blocking)", { message_id: msg.id, detail: emitErr.message });
  }

  return { consumer_key, status: "ok" };
}
