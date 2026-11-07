/**
 * Contrato do novo degrau OpenRouter. Aqui o fetch é interceptado e os bytes
 * são sintéticos; multipart na rede e áudio OGG/Opus válido pertencem ao E2E.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as ModuloDeEnv from "@/lib/env";

vi.mock("@/lib/env", async (importOriginal) => {
  const real = await importOriginal<typeof ModuloDeEnv>();
  return {
    env: {
      ...real.env,
      TRANSCRIPTION_API_KEY: "",
      TRANSCRIPTION_BASE_URL: "",
      TRANSCRIPTION_MODEL: "",
      TRANSCRIPTION_LANGUAGES: "",
    },
  };
});

import { EgressBlockedError } from "@/lib/agent-engine/edge/egress";
import { decidirTranscricao } from "@/lib/messaging/media/escada-de-transcricao";
import { MAX_MEDIA_BYTES } from "@/lib/messaging/media/types";

const LIMITE_DOCUMENTADO_BYTES = 25_000_000; // 25 MB, apenas neste fornecedor.
const AUDIO_GRANDE = Buffer.alloc(LIMITE_DOCUMENTADO_BYTES + 1);
const CONVERSA = {
  provider: "openrouter",
  modelId: "mistralai/modelo-de-controle",
  apiKey: "chave-sintetica-de-controle",
  baseUrl: "https://stt.exemplo.invalid/api/v1",
};

const fetchMock = vi.fn<typeof fetch>();

async function escolher(chaveOpenai: string | null = null) {
  return decidirTranscricao({
    conversa: CONVERSA,
    idiomas: ["pt"],
    chaveOpenai: async () => chaveOpenai,
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => Response.json({ text: "frase sintética" }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenRouter conserva a contenção do transporte de chat", () => {
  it("usa o endpoint escolhido e redirect manual antes de enviar o multipart", async () => {
    const decisao = await escolher();
    expect(await decisao.transcriber!.transcribe(Buffer.from("controle"), "audio/ogg")).toBe("frase sintética");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://stt.exemplo.invalid/api/v1/audio/transcriptions");
    expect(init?.redirect).toBe("manual");
    expect((init?.body as FormData).get("model")).toBe("openai/whisper-large-v3");
    expect((init?.body as FormData).get("language")).toBe("pt");
  });

  it("recusa redirect para fora do endpoint e não segue para outro host", async () => {
    fetchMock.mockResolvedValue(new Response(null, {
      status: 307,
      headers: { location: "https://outro.exemplo.invalid/arquivo" },
    }));
    const decisao = await escolher();
    await expect(decisao.transcriber!.transcribe(Buffer.from("controle"), "audio/ogg"))
      .rejects.toBeInstanceOf(EgressBlockedError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("o limite multipart pertence ao degrau OpenRouter", () => {
  it("recusa mais de 25 MB antes de chamar o transporte", async () => {
    const decisao = await escolher();
    await expect(decisao.transcriber!.transcribe(AUDIO_GRANDE, "audio/ogg"))
      .rejects.toThrow("transcription_audio_too_large");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aceita o limite exato, preservando o teto global de 50 MiB", async () => {
    const decisao = await escolher();
    await expect(decisao.transcriber!.transcribe(AUDIO_GRANDE.subarray(0, LIMITE_DOCUMENTADO_BYTES), "audio/ogg"))
      .resolves.toBe("frase sintética");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(MAX_MEDIA_BYTES).toBe(50 * 1024 * 1024);
  });

  it("a prioridade OpenAI continua anterior e não recebe a restrição deste degrau", async () => {
    const decisao = await escolher("outra-chave-de-controle");
    expect(decisao.origem).toBe("padrao_openai_compativel");
    await expect(decisao.transcriber!.transcribe(AUDIO_GRANDE, "audio/ogg"))
      .resolves.toBe("frase sintética");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("usage.cost é medição em USD, sem estimativa de preço", () => {
  it.each([
    { cost: 0.000508, cents: 0.0508 },
    { cost: 1, cents: 100 },
    { cost: 0, cents: 0 },
    { cost: undefined, cents: null },
    { cost: null, cents: null },
    { cost: -1, cents: null },
    { cost: "0.5", cents: null },
  ])("converte $cost USD para $cents centavos, sem transformar ausência em zero", async ({ cost, cents }) => {
    fetchMock.mockImplementation(async () => Response.json({ text: "frase sintética", usage: { cost } }));
    const decisao = await escolher();
    const medir = decisao.transcriber!.transcribeMedindo;
    expect(medir).toBeTypeOf("function");
    const resultado = await medir!(Buffer.from("controle"), "audio/ogg");
    expect(resultado).toMatchObject({ texto: "frase sintética", uso: null, custoCents: cents });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
