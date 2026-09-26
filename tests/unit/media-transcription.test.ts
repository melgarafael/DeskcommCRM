import { describe, expect, it, vi } from "vitest";

import {
  apiTranscriptionProvider,
  idiomasDaTranscricao,
  modeloDeTranscricaoEmVigor,
} from "@/lib/messaging/media/transcription";

function respostaOk() {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ text: "ok" }), { status: 200, headers: { "content-type": "application/json" } }),
  );
}

async function corpoEnviado(creds: Parameters<typeof apiTranscriptionProvider>[0]): Promise<FormData> {
  const fetchMock = respostaOk();
  await apiTranscriptionProvider(creds, fetchMock).transcribe(Buffer.from([1]), "audio/ogg");
  return fetchMock.mock.calls[0]![1].body as FormData;
}

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

// Medido numa loja em espanhol (26/09/2026): sem idioma declarado, `whisper-1`
// transformou um áudio sem fala em "Thanks for watching!" e um cancelamento em
// grego. O idioma tem de chegar ao serviço — e no campo que CADA modelo aceita.
describe("idioma da transcrição", () => {
  it("sem idioma configurado, o corpo não leva campo de idioma (comportamento de sempre)", async () => {
    const corpo = await corpoEnviado({ apiKey: "sk-test" });
    expect(corpo.get("model")).toBe("whisper-1");
    expect(corpo.has("language")).toBe(false);
    expect(corpo.has("languages[]")).toBe(false);
  });

  it("whisper-1 e os modelos anteriores recebem UM `language`", async () => {
    for (const model of ["whisper-1", "gpt-4o-transcribe", "whisper-large-v3"]) {
      const corpo = await corpoEnviado({ apiKey: "sk-test", model, languages: ["es", "gn"] });
      expect(corpo.getAll("language")).toEqual(["es"]);
      expect(corpo.has("languages[]")).toBe(false);
    }
  });

  it("gpt-transcribe e gpt-live-transcribe recebem a LISTA `languages[]`, nunca os dois campos", async () => {
    for (const model of ["gpt-transcribe", "gpt-live-transcribe"]) {
      const corpo = await corpoEnviado({ apiKey: "sk-test", model, languages: ["es", "gn"] });
      expect(corpo.get("model")).toBe(model);
      expect(corpo.getAll("languages[]")).toEqual(["es", "gn"]);
      expect(corpo.has("language")).toBe(false);
    }
  });

  it("TRANSCRIPTION_LANGUAGES é lido com tolerância: grafia errada fica de fora sem derrubar nada", () => {
    expect(idiomasDaTranscricao(" ES, pt ,x1,, gn")).toEqual(["es", "pt", "gn"]);
    expect(idiomasDaTranscricao("")).toEqual([]);
    expect(idiomasDaTranscricao(undefined)).toEqual([]);
  });

  it("o modelo em vigor é o do ambiente quando definido, senão whisper-1 — o mesmo para worker e tela", () => {
    const semServico = { apiKey: undefined, baseUrl: undefined };
    expect(modeloDeTranscricaoEmVigor({ ...semServico, model: undefined })).toBe("whisper-1");
    expect(modeloDeTranscricaoEmVigor({ ...semServico, model: "  " })).toBe("whisper-1");
    expect(modeloDeTranscricaoEmVigor({ ...semServico, model: "gpt-transcribe" })).toBe("gpt-transcribe");
  });

  it("modelo escrito para outro serviço (BASE_URL sem API_KEY) não vai para a OpenAI: vale whisper-1", () => {
    const groq = "https://api.groq.com/openai/v1";
    expect(modeloDeTranscricaoEmVigor({ model: "whisper-large-v3", apiKey: "", baseUrl: groq })).toBe("whisper-1");
    // Com a chave própria, o modelo vai ao serviço dele — e vale.
    expect(modeloDeTranscricaoEmVigor({ model: "whisper-large-v3", apiKey: "k", baseUrl: groq })).toBe(
      "whisper-large-v3",
    );
  });
});
