import { describe, expect, it, vi } from "vitest";

import { elevenLabsTranscriptionProvider } from "@/lib/messaging/media/transcription-elevenlabs";

describe("elevenLabsTranscriptionProvider", () => {
  it("POSTa multipart pro /v1/speech-to-text com xi-api-key e devolve o texto", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: "olá, quero comprar" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const provider = elevenLabsTranscriptionProvider({ apiKey: "sk_test" }, fetchMock);
    const text = await provider.transcribe(Buffer.from([1, 2, 3]), "audio/ogg; codecs=opus");
    expect(text).toBe("olá, quero comprar");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/v1/speech-to-text");
    // Não é `Authorization: Bearer` — tratar como "mesmo formato da OpenAI" é
    // exatamente o engano que faria este header saber errado em produção.
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe("sk_test");
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(init.body).toBeInstanceOf(FormData);
  });

  it("manda model_id (não `model`) com o default scribe_v1", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: "x" }), { status: 200 }),
    );
    const provider = elevenLabsTranscriptionProvider({ apiKey: "sk_test" }, fetchMock);
    await provider.transcribe(Buffer.from([1]), "audio/ogg");
    const [, init] = fetchMock.mock.calls[0]!;
    const body = init.body as FormData;
    expect(body.get("model_id")).toBe("scribe_v1");
    expect(body.get("model")).toBeNull();
  });

  it("propaga erro HTTP do provider", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("nope", { status: 401 }));
    const provider = elevenLabsTranscriptionProvider({ apiKey: "bad" }, fetchMock);
    await expect(provider.transcribe(Buffer.from([1]), "audio/ogg")).rejects.toThrow(/transcription_401/);
  });
});
