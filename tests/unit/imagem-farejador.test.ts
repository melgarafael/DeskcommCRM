import { describe, expect, it } from "vitest";

import { detectarTipoImagem, mimeDaImagem } from "@/lib/comercial/imagem";

/** Bytes mágicos reais (não cabeçalhos declarados). */
describe("detectarTipoImagem", () => {
  it("acha JPEG, PNG e WebP", () => {
    expect(detectarTipoImagem(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpg");
    expect(
      detectarTipoImagem(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ).toBe("png");
    expect(
      detectarTipoImagem(
        new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]),
      ),
    ).toBe("webp");
  });

  it("recusa o resto (PDF fingindo ser foto, inclusive)", () => {
    expect(detectarTipoImagem(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBeNull();
    expect(detectarTipoImagem(new Uint8Array([]))).toBeNull();
    expect(detectarTipoImagem(new Uint8Array([0xff, 0xd8]))).toBeNull();
  });

  it("mime certo para o upload", () => {
    expect(mimeDaImagem("jpg")).toBe("image/jpeg");
    expect(mimeDaImagem("png")).toBe("image/png");
    expect(mimeDaImagem("webp")).toBe("image/webp");
  });
});
