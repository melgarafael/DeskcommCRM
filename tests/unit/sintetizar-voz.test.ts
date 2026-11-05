import { describe, expect, it, vi } from "vitest";

import { sintetizarVoz } from "@/lib/ai/voz/sintetizar";

function respostaDeAudio(bytes: number[], contentType = "audio/mpeg") {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { "content-type": contentType },
  });
}

describe("sintetizarVoz", () => {
  it("POSTa JSON pro /v1/text-to-speech/{voiceId} com xi-api-key e devolve o áudio", async () => {
    const fetchMock = vi.fn().mockResolvedValue(respostaDeAudio([1, 2, 3, 4]));
    const r = await sintetizarVoz(
      { apiKey: "sk_test", voiceId: "abc123", texto: "olá, boa tarde" },
      fetchMock,
    );
    expect(r.audio).toBeInstanceOf(Buffer);
    expect(r.audio.length).toBe(4);
    expect(r.mimeType).toBe("audio/mpeg");
    expect(r.caracteres).toBe("olá, boa tarde".length);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/v1/text-to-speech/abc123");
    const headers = init.headers as Record<string, string>;
    expect(headers["xi-api-key"]).toBe("sk_test");
    expect(headers.Authorization).toBeUndefined();
    const body = JSON.parse(init.body as string);
    expect(body.text).toBe("olá, boa tarde");
    expect(body.model_id).toBe("eleven_multilingual_v2");
    expect(body.voice_settings).toEqual({ stability: 0.5, similarity_boost: 0.75 });
  });

  it("aceita model_id e voice_settings customizados", async () => {
    const fetchMock = vi.fn().mockResolvedValue(respostaDeAudio([1]));
    await sintetizarVoz(
      {
        apiKey: "sk_test",
        voiceId: "voice-x",
        texto: "x",
        modelId: "eleven_turbo_v2",
        stability: 0.2,
        similarityBoost: 0.9,
      },
      fetchMock,
    );
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init.body as string);
    expect(body.model_id).toBe("eleven_turbo_v2");
    expect(body.voice_settings).toEqual({ stability: 0.2, similarity_boost: 0.9 });
  });

  it("codifica o voice_id na URL (defesa contra id com caractere especial)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(respostaDeAudio([1]));
    await sintetizarVoz({ apiKey: "sk", voiceId: "a/b c", texto: "x" }, fetchMock);
    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain(encodeURIComponent("a/b c"));
  });

  it("propaga erro HTTP do provider", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("nope", { status: 401 }));
    await expect(
      sintetizarVoz({ apiKey: "bad", voiceId: "x", texto: "y" }, fetchMock),
    ).rejects.toThrow(/synthesis_401/);
  });
});

describe("sintetizarVoz em ogg/opus — a nota de voz do canal oficial", () => {
  /** O começo real de um arquivo OGG/Opus, como a ElevenLabs devolveu (medido em 02/11/2026). */
  const OGG = [..."OggS"].map((c) => c.charCodeAt(0)).concat([0, 2, 0, 0]);

  it("pede `output_format=opus_48000_32`, e etiqueta o áudio como audio/ogg;codecs=opus (não o audio/opus da resposta)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(respostaDeAudio(OGG, "audio/opus"));
    const r = await sintetizarVoz({ apiKey: "sk", voiceId: "v1", texto: "hola", formato: "ogg_opus" }, fetchMock);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(/\/v1\/text-to-speech\/v1\?output_format=opus_48000_32$/);
    expect((init.headers as Record<string, string>).accept).toBe("*/*");
    // O canal oficial lista `audio/ogg (OPUS codecs only)` — a etiqueta da
    // ElevenLabs (`audio/opus`) gravada no Storage faria a plataforma recusar.
    expect(r.mimeType).toBe("audio/ogg;codecs=opus");
    expect(r.caracteres).toBe(4);
  });

  it("áudio que NÃO é OGG lança — o envio cai para texto, em vez de mandar anexo ou falhar no canal", async () => {
    const fetchMock = vi.fn().mockResolvedValue(respostaDeAudio([0xff, 0xfb, 0x90, 0x00], "audio/mpeg"));
    await expect(
      sintetizarVoz({ apiKey: "sk", voiceId: "v1", texto: "hola", formato: "ogg_opus" }, fetchMock),
    ).rejects.toThrow("synthesis_formato_inesperado");
  });

  it("sem formato, segue o mp3 de sempre — sem query na URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(respostaDeAudio([1, 2, 3, 4]));
    await sintetizarVoz({ apiKey: "sk", voiceId: "v1", texto: "hola" }, fetchMock);
    expect(String(fetchMock.mock.calls[0]![0])).not.toContain("output_format");
  });
});

