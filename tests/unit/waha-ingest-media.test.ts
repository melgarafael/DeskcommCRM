import { describe, expect, it, vi } from "vitest";

// ingest.ts importa @/lib/audit (→ supabase/server → validação de env);
// os helpers testados aqui são puros — mock corta a cadeia.
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import {
  mediaMimeOf,
  mediaUrlOf,
  resolveMessageType,
  type WahaPayload,
} from "@/lib/waha/ingest";

// Formato real do WAHA 2026.7.1 / NOWEB capturado em webhook_events_log:
// mídia em payload.media.{url,mimetype}; sem `type`; conteúdo em _data.message.
function nowebPayload(messageKey: string, mimetype: string): WahaPayload {
  return {
    id: "false_x@lid_ABC",
    from: "59782320914646@lid",
    fromMe: false,
    hasMedia: true,
    media: {
      url: "http://localhost:3000/api/files/sessao/ABC.bin",
      mimetype,
      filename: null,
    },
    _data: { message: { [messageKey]: {}, messageContextInfo: {} } },
  };
}

describe("mediaUrlOf / mediaMimeOf", () => {
  it("lê o formato novo (payload.media.*)", () => {
    const p = nowebPayload("imageMessage", "image/jpeg");
    expect(mediaUrlOf(p)).toBe("http://localhost:3000/api/files/sessao/ABC.bin");
    expect(mediaMimeOf(p)).toBe("image/jpeg");
  });

  it("mantém o formato legado (payload.mediaUrl) com precedência", () => {
    const p: WahaPayload = { mediaUrl: "http://w/legacy.jpg", mimetype: "image/png" };
    expect(mediaUrlOf(p)).toBe("http://w/legacy.jpg");
    expect(mediaMimeOf(p)).toBe("image/png");
  });

  it("retorna null sem mídia", () => {
    expect(mediaUrlOf({ body: "oi" })).toBeNull();
    expect(mediaMimeOf({ body: "oi" })).toBeNull();
  });
});

describe("resolveMessageType", () => {
  it("usa `type` explícito quando presente (legado)", () => {
    expect(resolveMessageType({ type: "ptt" })).toBe("audio");
    expect(resolveMessageType({ type: "chat" })).toBe("text");
  });

  it("infere pela chave de _data.message (NOWEB sem type)", () => {
    expect(resolveMessageType(nowebPayload("stickerMessage", "image/webp"))).toBe("sticker");
    expect(resolveMessageType(nowebPayload("imageMessage", "image/jpeg"))).toBe("image");
    expect(resolveMessageType(nowebPayload("audioMessage", "audio/ogg; codecs=opus"))).toBe("audio");
    expect(resolveMessageType(nowebPayload("videoMessage", "video/mp4"))).toBe("video");
    expect(resolveMessageType(nowebPayload("documentMessage", "application/pdf"))).toBe("document");
    expect(resolveMessageType(nowebPayload("documentWithCaptionMessage", "application/pdf"))).toBe(
      "document",
    );
  });

  it("cai no prefixo do MIME quando a chave é desconhecida", () => {
    const p = nowebPayload("futureMessageKind", "video/mp4");
    expect(resolveMessageType(p)).toBe("video");
  });

  it("webp sem chave conhecida vira sticker", () => {
    const p = nowebPayload("futureMessageKind", "image/webp");
    expect(resolveMessageType(p)).toBe("sticker");
  });

  it("sem type, sem message e sem mídia → text", () => {
    expect(resolveMessageType({ body: "oi" })).toBe("text");
  });
});
