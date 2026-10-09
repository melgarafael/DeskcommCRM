/**
 * Helpers puros da renderização de mídia no inbox (Onda 1).
 * A mídia é SEMPRE servida por /api/v1/messages/{id}/media (Onda 0) —
 * o browser segue o 302 pra signed URL; nunca usar media_url do WAHA.
 */
import { nomeDeArquivoLimpo } from "@/lib/messaging/media/nome-de-arquivo";

export function mediaSrc(messageId: string): string {
  return `/api/v1/messages/${messageId}/media`;
}

/**
 * Nome ORIGINAL do documento quando a ingestão o persistiu em
 * `metadata.media_filename` (#2613). O path de storage é canônico
 * (`{org}/{conversa}/{mensagem}.{ext}`) e não guarda o nome que o cliente
 * mandou; sem esta chave o cartão cai no rótulo de extensão de hoje.
 *
 * Guarda por valor, não por presença: `null`/não-string/vazio não é nome.
 */
export function nomeOriginalDoDocumento(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  return nomeDeArquivoLimpo((metadata as Record<string, unknown>).media_filename);
}

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toLocaleString("pt-BR", { maximumFractionDigits: 1, minimumFractionDigits: 1 })} KB`;
  const mb = kb / 1024;
  return `${mb.toLocaleString("pt-BR", { maximumFractionDigits: 1, minimumFractionDigits: 1 })} MB`;
}

/**
 * Rótulo do arquivo: NOME ORIGINAL quando o payload o trouxer (#2613) >
 * extensão do path ("PDF") > sufixo do mime > "Arquivo".
 *
 * O nome vem do terceiro parâmetro, nunca do path: `media_storage_path` é
 * canônico (`{org}/{conversa}/{mensagem}.{ext}`) e apaga o nome que o cliente
 * mandou. Sem nome, o rótulo continua sendo a extensão de hoje — a chamada de
 * duas argumentos não muda de resultado.
 */
export function mediaFileLabel(
  mime: string | null,
  storagePath: string | null,
  fileName?: string | null,
): string {
  const nome = fileName?.trim();
  if (nome) return nome;
  const ext = storagePath?.split(".").pop()?.toLowerCase();
  if (ext && ext !== "bin") return ext.toUpperCase();
  const sub = mime?.split(";")[0]?.split("/")[1]?.toLowerCase();
  if (sub && !["octet-stream", "bin"].includes(sub)) return sub.toUpperCase();
  return "Arquivo";
}
