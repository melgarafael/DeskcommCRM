/**
 * Helpers puros da renderização de mídia no inbox (Onda 1).
 * A mídia é SEMPRE servida por /api/v1/messages/{id}/media (Onda 0) —
 * o browser segue o 302 pra signed URL; nunca usar media_url do WAHA.
 */
import { extFromMime } from "@/lib/messaging/media/types";
import { nomeOriginalDaMensagem } from "@/lib/messaging/media/nome-de-arquivo";

export function mediaSrc(messageId: string): string {
  return `/api/v1/messages/${messageId}/media`;
}

/**
 * Link do DOWNLOAD: a mesma rota, com `?baixar=1` (#2613).
 *
 * A diferença não é cosmética. Sem o parâmetro a rota responde 302 para a URL
 * assinada sem `download`, e o navegador salva o basename canônico
 * (`{uuid}.pdf`) — o nome original morria na última etapa, depois de a tela já
 * mostrá-lo. Com o parâmetro, e SÓ quando a mensagem tem nome guardado, a rota
 * pede ao Storage o `Content-Disposition` com esse nome.
 */
export function mediaDownloadSrc(messageId: string): string {
  return `${mediaSrc(messageId)}?baixar=1`;
}

/**
 * Nome ORIGINAL do documento quando a ingestão o persistiu em
 * `metadata.media_filename` (#2613). O path de storage é canônico
 * (`{org}/{conversa}/{mensagem}.{ext}`) e não guarda o nome que o cliente
 * mandou; sem esta chave o cartão cai no fallback `Documento XLSX`.
 *
 * Guarda por valor, não por presença: `null`/não-string/vazio não é nome.
 */
export function nomeOriginalDoDocumento(metadata: unknown): string | null {
  return nomeOriginalDaMensagem(metadata);
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
 * A extensão do documento (`PDF`, `XLSX`), ou `null` quando não há como dizer.
 *
 * Sai do path quando ele a tem (é o que a ingestão gravou) e cai no mapa
 * canônico de MIME quando não. `bin`/`octet-stream` não são extensão: são a AUSÊNCIA de
 * uma, e devolver `BIN` seria inventar um formato que ninguém mandou.
 */
export function extensaoDoDocumento(
  mime: string | null,
  storagePath: string | null,
): string | null {
  const ext = storagePath?.split(".").pop()?.toLowerCase();
  if (ext && ext !== "bin") return ext.toUpperCase();
  const peloMime = extFromMime(mime ?? "");
  return peloMime === "bin" ? null : peloMime.toUpperCase();
}

/**
 * Rótulo do arquivo: NOME ORIGINAL quando o payload o trouxer (#2613) >
 * extensão do path ("PDF") > mapa canônico de MIME > "Arquivo".
 *
 * O nome vem do terceiro parâmetro, nunca do path: `media_storage_path` é
 * canônico (`{org}/{conversa}/{mensagem}.{ext}`) e apaga o nome que o cliente
 * mandou. Sem nome, o rótulo continua sendo a extensão — este helper é PURO e
 * não conhece idioma; quem compõe o fallback traduzido (`Documento PDF`) é o
 * `DocumentCard`, com `t()`.
 */
export function mediaFileLabel(
  mime: string | null,
  storagePath: string | null,
  fileName?: string | null,
): string {
  const nome = fileName?.trim();
  if (nome) return nome;
  return extensaoDoDocumento(mime, storagePath) ?? "Arquivo";
}
