/**
 * Tipos canônicos de mídia do messaging — camada provider-agnóstica.
 * Hoje só o WAHA produz mídia; a Meta Cloud API (futura) implementa a mesma
 * interface de fetch e o resto do sistema não muda (spec Onda 0).
 */

export const MAX_MEDIA_BYTES = 52_428_800; // 50MB — espelha file_size_limit do bucket

export interface FetchedMedia {
  buffer: Buffer;
  mime: string;
}

export class MediaTooLargeError extends Error {
  constructor() {
    super(`media exceeds ${MAX_MEDIA_BYTES} bytes`);
    this.name = "MediaTooLargeError";
  }
}

const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/amr": "amr",
  "application/pdf": "pdf",
};

export function extFromMime(mime: string): string {
  const base = (mime ?? "").split(";")[0]!.trim().toLowerCase();
  return MIME_EXT[base] ?? "bin";
}

/** Path canônico no bucket whatsapp-media: {org}/{conversa}/{mensagem}.{ext} */
export function storagePathFor(
  orgId: string,
  conversationId: string,
  messageId: string,
  mime: string,
): string {
  return `${orgId}/${conversationId}/${messageId}.${extFromMime(mime)}`;
}
