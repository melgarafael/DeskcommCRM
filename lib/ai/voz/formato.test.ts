import { describe, expect, it } from "vitest";

import { ehContainerOgg, extensaoDoFormato, formatoDaVozParaCanal, mimeDoCaminhoDeVoz } from "./formato";

describe("formato da nota de voz do agente", () => {
  it("o canal que converte recebe mp3; o oficial (opus-only), ogg/opus", () => {
    expect(formatoDaVozParaCanal("server-convert")).toBe("mp3");
    expect(formatoDaVozParaCanal("opus-only")).toBe("ogg_opus");
    expect(extensaoDoFormato("ogg_opus")).toBe("ogg");
    expect(extensaoDoFormato("mp3")).toBe("mp3");
  });

  it("o retry lê o formato do caminho", () => {
    expect(mimeDoCaminhoDeVoz("org/conv/voz-agente-j-1.ogg")).toBe("audio/ogg;codecs=opus");
    expect(mimeDoCaminhoDeVoz("org/conv/voz-agente-j-1.OGG")).toBe("audio/ogg;codecs=opus");
    expect(mimeDoCaminhoDeVoz("org/conv/voz-agente-j-1.mp3")).toBe("audio/mpeg");
  });

  it("reconhece o contêiner OGG pelos bytes, não pelo cabeçalho", () => {
    expect(ehContainerOgg(Buffer.from("OggS\u0000\u0002"))).toBe(true);
    expect(ehContainerOgg(Buffer.from([0xff, 0xfb, 0x90, 0x00]))).toBe(false);
    expect(ehContainerOgg(Buffer.from("Ogg"))).toBe(false);
  });
});
