import { describe, expect, it } from "vitest";

import {
  extFromMime,
  storagePathFor,
  MAX_MEDIA_BYTES,
} from "@/lib/messaging/media/types";

describe("extFromMime", () => {
  it("mapeia mimes comuns do WhatsApp", () => {
    expect(extFromMime("image/jpeg")).toBe("jpg");
    expect(extFromMime("image/png")).toBe("png");
    expect(extFromMime("image/webp")).toBe("webp"); // figurinhas
    expect(extFromMime("video/mp4")).toBe("mp4");
    expect(extFromMime("application/mp4")).toBe("mp4"); // mime real observado no WAHA 2026.7.1
    expect(extFromMime("audio/ogg; codecs=opus")).toBe("ogg"); // PTT
    expect(extFromMime("audio/mpeg")).toBe("mp3");
    expect(extFromMime("application/pdf")).toBe("pdf");
  });
  it("cai em bin para mime desconhecido", () => {
    expect(extFromMime("application/x-unknown")).toBe("bin");
    expect(extFromMime("")).toBe("bin");
  });
});

describe("storagePathFor", () => {
  it("monta o path canônico org/conversa/mensagem.ext", () => {
    expect(storagePathFor("org1", "conv2", "msg3", "image/jpeg")).toBe("org1/conv2/msg3.jpg");
  });
});

describe("MAX_MEDIA_BYTES", () => {
  it("é 50MB", () => {
    expect(MAX_MEDIA_BYTES).toBe(52_428_800);
  });
});
