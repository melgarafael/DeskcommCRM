/**
 * MediaSource do WAHA: baixa o binário hospedado pelo container WAHA.
 *
 * A URL anunciada no webhook NÃO é confiável nem correta: o HMAC é
 * best-effort (payload forjado é possível) e o WAHA anuncia seu endereço
 * INTERNO (ex.: localhost:3000 dentro do container, mapeado p/ 3030 no
 * host). Por isso o fetch é SEMPRE reconstruído sobre WAHA_API_BASE_URL,
 * aproveitando apenas path+query da URL anunciada — SSRF impossível por
 * construção (o host nunca vem do payload). A futura MetaMediaSource
 * implementa a mesma assinatura baixando via media_id + Graph API.
 */
import {
  MAX_MEDIA_BYTES,
  MediaTooLargeError,
  type FetchedMedia,
} from "@/lib/messaging/media/types";

const FETCH_TIMEOUT_MS = 30_000;

export async function fetchWahaMedia(
  mediaUrl: string,
  hintMime?: string | null,
): Promise<FetchedMedia> {
  const base = process.env.WAHA_API_BASE_URL;
  let url: URL;
  try {
    const advertised = new URL(mediaUrl);
    // Host/porta descartados: só path+query sobrevivem, resolvidos na base.
    url = new URL(advertised.pathname + advertised.search, base ?? "");
  } catch {
    throw new Error("waha_media_untrusted_host");
  }

  const apiKey = process.env.WAHA_API_KEY;
  const res = await fetch(url.toString(), {
    headers: apiKey ? { "X-Api-Key": apiKey } : {},
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`waha_media_${res.status}`);

  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_MEDIA_BYTES) throw new MediaTooLargeError();

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength > MAX_MEDIA_BYTES) throw new MediaTooLargeError();

  const mime = res.headers.get("content-type") || hintMime || "application/octet-stream";
  return { buffer, mime };
}
