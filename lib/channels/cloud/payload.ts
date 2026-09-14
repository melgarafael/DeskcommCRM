/**
 * Payloads da família Cloud API (Meta e parceiros Graph-compatíveis).
 *
 * Extraído do adapter oficial quando o Datafy entrou: os dois falam o MESMO
 * dialeto de mensagem, e manter duas cópias do `mediaPayload` garantiria que a
 * primeira correção de mídia em um lado faltasse no outro. Não carrega nome de
 * provider de propósito — é a parte neutra que os dois compartilham.
 */
import { metaContactsPayload } from "@/lib/channels/meta/contact-card";

import type { OutboundEnvelope } from "../types";

/** Só dígitos. `+55 (31) 99896-6398` → `5531998966398`. */
export function toE164Digits(raw: string): string {
  return raw.replace(/\D/g, "");
}

/** `kind: "contact"` → objeto `contacts` da Cloud API. */
export function cloudContactPayload(env: OutboundEnvelope): Record<string, unknown> | null {
  if (env.kind !== "contact" || !env.contact) return null;
  return {
    type: "contacts",
    contacts: metaContactsPayload(env.contact.fullName, env.contact.phoneNumber),
  };
}

/** `kind` do envelope → objeto de mídia da Cloud API. */
export function cloudMediaPayload(env: OutboundEnvelope): Record<string, unknown> | null {
  if (!env.media) return null;
  const link = env.media.url;
  const caption = env.media.caption ?? undefined;

  switch (env.kind) {
    case "image":
      return { type: "image", image: { link, ...(caption ? { caption } : {}) } };
    case "video":
      return { type: "video", video: { link, ...(caption ? { caption } : {}) } };
    case "audio":
      // `voice: true` é o que faz virar BOLHA DE VOZ. Sem ele, anexo de música.
      // Exige ogg/opus — a Meta não converte, diferente do canal por QR.
      return { type: "audio", audio: { link, voice: true } };
    default:
      return {
        type: "document",
        document: {
          link,
          ...(env.media.filename ? { filename: env.media.filename } : {}),
          ...(caption ? { caption } : {}),
        },
      };
  }
}
