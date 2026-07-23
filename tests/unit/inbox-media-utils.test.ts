import { describe, expect, it } from "vitest";

import {
  formatBytes,
  mediaFileLabel,
  mediaSrc,
} from "@/components/inbox/media/media-utils";

describe("mediaSrc", () => {
  it("monta a URL do endpoint da Onda 0", () => {
    expect(mediaSrc("abc-123")).toBe("/api/v1/messages/abc-123/media");
  });
});

describe("formatBytes", () => {
  it("formata em pt-BR base 1024", () => {
    expect(formatBytes(853)).toBe("853 B");
    expect(formatBytes(41598)).toBe("40,6 KB");
    expect(formatBytes(12563831)).toBe("12,0 MB");
  });
  it("devolve travessão sem valor", () => {
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(undefined)).toBe("—");
    expect(formatBytes(0)).toBe("—");
  });
});

describe("mediaFileLabel", () => {
  it("prefere a extensão do storage path", () => {
    expect(mediaFileLabel("application/pdf", "org/conv/msg.pdf")).toBe("PDF");
    expect(mediaFileLabel("application/mp4", "org/conv/msg.mp4")).toBe("MP4");
  });
  it("cai pro sufixo do mime sem path", () => {
    expect(mediaFileLabel("application/pdf", null)).toBe("PDF");
  });
  it("fallback genérico", () => {
    expect(mediaFileLabel(null, null)).toBe("Arquivo");
    expect(mediaFileLabel("application/octet-stream", "org/conv/msg.bin")).toBe("Arquivo");
  });
});
