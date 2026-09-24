import { describe, expect, it, vi } from "vitest";

import { apiTranscriptionProvider } from "@/lib/messaging/media/transcription";

describe("apiTranscriptionProvider", () => {
  it("POSTa multipart pro endpoint de transcrição e devolve o texto", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: "olá, quero comprar" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const provider = apiTranscriptionProvider({ apiKey: "sk-test" }, fetchMock);
    const text = await provider.transcribe(Buffer.from([1, 2, 3]), "audio/ogg; codecs=opus");
    expect(text).toBe("olá, quero comprar");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/v1/audio/transcriptions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    expect(init.body).toBeInstanceOf(FormData);
  });

  it("propaga erro HTTP do provider", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("nope", { status: 401 }));
    const provider = apiTranscriptionProvider({ apiKey: "bad" }, fetchMock);
    await expect(provider.transcribe(Buffer.from([1]), "audio/ogg")).rejects.toThrow(/transcription_401/);
  });

  it("normaliza baseUrl em todos os formatos sem duplicar /v1 nem manter barra final", async () => {
    const cenarios = [
      { input: undefined, esperado: "https://api.openai.com/v1/audio/transcriptions" },
      { input: "https://api.openai.com", esperado: "https://api.openai.com/v1/audio/transcriptions" },
      { input: "https://api.openai.com/", esperado: "https://api.openai.com/v1/audio/transcriptions" },
      { input: "https://api.groq.com/openai/v1", esperado: "https://api.groq.com/openai/v1/audio/transcriptions" },
      { input: "https://api.groq.com/openai/v1/", esperado: "https://api.groq.com/openai/v1/audio/transcriptions" },
      { input: "http://10.0.0.1:8000/v1", esperado: "http://10.0.0.1:8000/v1/audio/transcriptions" },
      { input: "http://10.0.0.1:8000", esperado: "http://10.0.0.1:8000/v1/audio/transcriptions" },
    ];

    for (const c of cenarios) {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ text: "ok" }), { status: 200, headers: { "content-type": "application/json" } }),
      );
      const provider = apiTranscriptionProvider({ apiKey: "sk-test", baseUrl: c.input }, fetchMock);
      await provider.transcribe(Buffer.from([1]), "audio/ogg");
      expect(String(fetchMock.mock.calls[0]![0])).toBe(c.esperado);
    }
  });
});
