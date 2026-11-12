import { describe, expect, it } from "vitest";

import { nomeParaBaixar } from "./nome-para-baixar";

const base = {
  id: "c98de420-9e85-4177-9c72-846bbae57276",
  nomeOriginal: null,
  media_mime: "image/jpeg",
  media_storage_path: "org/conv/c98de420-9e85-4177-9c72-846bbae57276.jpg",
  sent_at: "2026-11-09T17:14:30.000Z",
};

describe("nomeParaBaixar", () => {
  it("o nome original sempre vence", () => {
    expect(nomeParaBaixar({ ...base, nomeOriginal: "RG frente.jpg" }, "America/Sao_Paulo")).toBe("RG frente.jpg");
  });

  it("foto sem nome: tipo, data e hora no fuso da organização, e o começo do id", () => {
    expect(nomeParaBaixar(base, "America/Sao_Paulo")).toBe("foto-2026-11-09-14h14-c98de4.jpg");
    expect(nomeParaBaixar(base, "Europe/Lisbon")).toBe("foto-2026-11-09-17h14-c98de4.jpg");
  });

  it("três fotos no mesmo minuto não colidem no nome", () => {
    const a = nomeParaBaixar(base, "UTC");
    const b = nomeParaBaixar({ ...base, id: "b647d9db-fbe2-457f-b2dd-27e6b366c610" }, "UTC");
    expect(a).not.toBe(b);
  });

  it("vídeo e áudio ganham o próprio prefixo; extensão cai para o MIME sem path", () => {
    expect(nomeParaBaixar({ ...base, media_mime: "video/mp4", media_storage_path: null }, "UTC")).toMatch(/^video-.*\.mp4$/);
    expect(nomeParaBaixar({ ...base, media_mime: "audio/ogg; codecs=opus", media_storage_path: null }, "UTC")).toMatch(/^audio-.*\.ogg$/);
  });

  it("fuso inválido ou data ausente não derrubam: o nome sai sem carimbo", () => {
    expect(nomeParaBaixar(base, "Nao/Existe")).toBe("foto-c98de4.jpg");
    expect(nomeParaBaixar({ ...base, sent_at: null }, "UTC")).toBe("foto-c98de4.jpg");
  });
});
