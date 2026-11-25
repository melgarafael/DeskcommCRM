import { describe, expect, it } from "vitest";

import { recusaDeFormatoDaRede } from "./formato-do-envio";

describe("recusaDeFormatoDaRede (TikTok, A21)", () => {
  it("texto e imagem JPG/PNG sem legenda saem", () => {
    expect(recusaDeFormatoDaRede("tiktok", { kind: "text" })).toBeNull();
    expect(recusaDeFormatoDaRede("tiktok", { kind: "image", mime: "image/jpeg" })).toBeNull();
    expect(recusaDeFormatoDaRede("tiktok", { kind: "image", mime: "image/png" })).toBeNull();
    // mime com parâmetro e caixa alta, como vêm do storage
    expect(recusaDeFormatoDaRede("tiktok", { kind: "image", mime: "IMAGE/PNG; charset=binary" })).toBeNull();
    // legenda vazia ou só espaços não é legenda
    expect(recusaDeFormatoDaRede("tiktok", { kind: "image", mime: "image/png", legenda: "  " })).toBeNull();
  });

  it("vídeo, áudio, arquivo e contato são recusados com a saída no texto", () => {
    for (const kind of ["video", "audio", "document", "contact", "location"]) {
      const motivo = recusaDeFormatoDaRede("tiktok", { kind, mime: "video/mp4" });
      expect(motivo, kind).toMatch(/só aceita texto ou uma imagem JPG ou PNG de até 3 MB/);
    }
  });

  it("imagem em outro formato (webp, gif) é recusada", () => {
    for (const mime of ["image/webp", "image/gif", "", null, undefined]) {
      expect(recusaDeFormatoDaRede("tiktok", { kind: "image", mime }), String(mime)).toMatch(/JPG ou PNG/);
    }
  });

  it("imagem com legenda é recusada: o TikTok não aceita imagem e texto juntos", () => {
    const motivo = recusaDeFormatoDaRede("tiktok", { kind: "image", mime: "image/jpeg", legenda: "Casa" });
    expect(motivo).toMatch(/não aceita imagem e texto na mesma mensagem/);
  });

  it("outras redes e rede ausente: nada é recusado por esta régua", () => {
    for (const rede of ["instagram", "facebook", "telegram", "", null, undefined, "constructor"]) {
      expect(recusaDeFormatoDaRede(rede, { kind: "video", mime: "video/mp4", legenda: "x" }), String(rede)).toBeNull();
    }
  });
});
