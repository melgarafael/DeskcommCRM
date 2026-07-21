/**
 * MediaSource do WAHA: baixa o binário hospedado pelo container WAHA.
 * O webhook HMAC é best-effort, então o host da mediaUrl É validado contra
 * WAHA_API_BASE_URL (anti-SSRF: payload forjado não faz o worker buscar
 * URL arbitrária). A futura MetaMediaSource implementa a mesma assinatura
 * baixando via media_id + Graph API.
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
  const url = new URL(mediaUrl);
  if (!base || url.host !== new URL(base).host) {
    throw new Error("waha_media_untrusted_host");
  }

  const apiKey = process.env.WAHA_API_KEY;
  const res = await fetch(mediaUrl, {
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
