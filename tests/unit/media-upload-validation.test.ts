import { describe, expect, it } from "vitest";

import { validateOutboundMedia } from "@/lib/messaging/media/upload-validation";

describe("validateOutboundMedia", () => {
  it("classifica mimes suportados no kind certo", () => {
    expect(validateOutboundMedia("image/jpeg", 1000)).toEqual({ ok: true, kind: "image" });
    expect(validateOutboundMedia("image/webp", 1000)).toEqual({ ok: true, kind: "image" });
    expect(validateOutboundMedia("video/mp4", 1000)).toEqual({ ok: true, kind: "video" });
    expect(validateOutboundMedia("audio/ogg; codecs=opus", 1000)).toEqual({ ok: true, kind: "audio" });
    expect(validateOutboundMedia("audio/webm", 1000)).toEqual({ ok: true, kind: "audio" });
    expect(validateOutboundMedia("application/pdf", 1000)).toEqual({ ok: true, kind: "document" });
    expect(validateOutboundMedia("text/csv", 1000)).toEqual({ ok: true, kind: "document" });
  });
  it("rejeita mime não suportado", () => {
    const r = validateOutboundMedia("application/x-msdownload", 1000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unsupported_media_type");
  });
  it("rejeita acima de 50MB", () => {
    const r = validateOutboundMedia("image/jpeg", 51 * 1024 * 1024);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("payload_too_large");
  });
  it("rejeita arquivo vazio", () => {
    const r = validateOutboundMedia("image/jpeg", 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("validation_failed");
  });
});
