/**
 * Helpers puros da renderização de mídia no inbox (Onda 1).
 * A mídia é SEMPRE servida por /api/v1/messages/{id}/media (Onda 0) —
 * o browser segue o 302 pra signed URL; nunca usar media_url do WAHA.
 */

export function mediaSrc(messageId: string): string {
  return `/api/v1/messages/${messageId}/media`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toLocaleString("pt-BR", { maximumFractionDigits: 1, minimumFractionDigits: 1 })} KB`;
  const mb = kb / 1024;
  return `${mb.toLocaleString("pt-BR", { maximumFractionDigits: 1, minimumFractionDigits: 1 })} MB`;
}

/** Rótulo curto do arquivo: extensão do path ("PDF") > sufixo do mime > "Arquivo". */
export function mediaFileLabel(mime: string | null, storagePath: string | null): string {
  const ext = storagePath?.split(".").pop()?.toLowerCase();
  if (ext && ext !== "bin") return ext.toUpperCase();
  const sub = mime?.split(";")[0]?.split("/")[1]?.toLowerCase();
  if (sub && !["octet-stream", "bin"].includes(sub)) return sub.toUpperCase();
  return "Arquivo";
}
