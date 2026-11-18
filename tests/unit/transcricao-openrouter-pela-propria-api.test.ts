/**
 * #3382 — nota de voz numa instalação SÓ-OpenRouter: quem transcreve é a
 * própria OpenRouter, em `/audio/transcriptions`, e não o modelo de conversa.
 *
 * O que o mantenedor mediu na `main`: sem `TRANSCRIPTION_*` e sem chave
 * OpenAI, a escada caía no degrau do modelo de conversa, que manda o áudio
 * como PARTE do chat — e o caminho de chat do `@ai-sdk/openai` recusa
 * `audio/ogg` ANTES de a chamada sair ("audio content parts with media type
 * audio/ogg functionality not supported"). Toda nota de voz terminava
 * `failed`. O contorno dele, provado: o OpenRouter tem serviço de
 * transcrição próprio, OpenAI-compatível, na MESMA chave.
 *
 * O primeiro caso é a prova VERMELHA sem o conserto: `audio/ogg` com
 * provedor OpenRouter chegando ao degrau errado (`modelo_da_organizacao` +
 * `generateText`). Os demais são CONTROLES: os degraus de antes não mudam de
 * lugar, `OPENROUTER_BASE_URL` muda o destino como no resto do produto, e o
 * idioma do `.env` chega ao serviço.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as ModuloDeEnv from "@/lib/env";

/**
 * O modelo de conversa SÓ é chamado no degrau errado — é o que o teste prende.
 * A implementação padrão devolve o formato real de `generateText`: sem ela o
 * controle do Google (que transcreve MESMO pelo modelo) receberia `undefined`
 * e quebraria em `res.text`.
 */
const generateTextMock = vi.hoisted(() =>
  vi.fn(async () => ({
    text: "transcrito pelo modelo",
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
  })),
);
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  generateText: generateTextMock,
}));

// A escada lê o trio da transcrição pela régua `env` (`lib/env.ts`), nunca
// pelo `process.env` cru (#855/#964) — `vi.stubEnv` não alcança esse caminho.
const transcricaoDoEnv = vi.hoisted(() => ({ apiKey: "", baseUrl: "", model: "", languages: "" }));
vi.mock("@/lib/env", async (importOriginal) => {
  const real = await importOriginal<typeof ModuloDeEnv>();
  return {
    env: {
      ...real.env,
      get TRANSCRIPTION_API_KEY() {
        return transcricaoDoEnv.apiKey;
      },
      get TRANSCRIPTION_BASE_URL() {
        return transcricaoDoEnv.baseUrl;
      },
      get TRANSCRIPTION_MODEL() {
        return transcricaoDoEnv.model;
      },
      get TRANSCRIPTION_LANGUAGES() {
        return transcricaoDoEnv.languages;
      },
    },
  };
});

/** Toda chamada que sai: destino, método, cabeçalho e o corpo em FormData. */
interface Chamada {
  url: string;
  init: RequestInit;
}
let chamadas: Chamada[] = [];

function ultimaChamada(): Chamada {
  const c = chamadas.at(-1);
  if (!c) throw new Error("nenhuma chamada de transcrição saiu");
  return c;
}

beforeEach(() => {
  chamadas = [];
  vi.clearAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      chamadas.push({ url: String(input), init });
      return new Response(JSON.stringify({ text: "bom dia" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

import { decidirTranscricao } from "@/lib/messaging/media/escada-de-transcricao";

/** Chaves de CONTROLE: valor inventado, nunca um segredo de verdade. */
const CHAVE_ORG = "chave-openrouter-de-controle";
const BEARER = "Bea" + "rer";

/** A conversa da organização da issue: OpenRouter como provedor único. */
const CONVERSA_OPENROUTER = {
  provider: "openrouter",
  apiKey: CHAVE_ORG,
  // Um modelo que a capacidade `audio` ACEITA (prefixo `google/`): é o caso em
  // que a escada antiga escolhia o degrau do modelo de conversa.
  modelId: "google/gemini-2.5-flash",
} as const;

describe("#3382 — o áudio audio/ogg com conversa OpenRouter vai para /audio/transcriptions do próprio OpenRouter", () => {
  it("e NUNCA pelo modelo de conversa: sem o conserto, o degrau errado é este", async () => {
    transcricaoDoEnv.apiKey = ""; transcricaoDoEnv.baseUrl = "";
    transcricaoDoEnv.model = "";
    transcricaoDoEnv.languages = "pt";

    const decisao = await decidirTranscricao({
      conversa: CONVERSA_OPENROUTER,
      chaveOpenai: async () => null,
    });

    // É ESTA a asserção vermelha sem o conserto: a escada antiga devolvia
    // `modelo_da_organizacao`, cujo `generateText` recusa `audio/ogg` antes de
    // a chamada sair — e toda nota de voz terminava `failed` (#3382).
    expect(
      decisao.origem,
      "o áudio foi parar no degrau do modelo de conversa, que a OpenRouter recusa",
    ).toBe("padrao_openrouter");
    expect(decisao.motivo).toMatch(/OpenRouter/);

    // A tela anuncia o degrau que RODA (#2190): o provedor da conversa e o
    // modelo de transcrição deles — não `whisper-1`, que não existe lá.
    expect(decisao.anuncio).toEqual({
      provider: "openrouter",
      modelId: "openai/whisper-large-v3",
    });

    const texto = await decisao.transcriber!.transcribe(Buffer.from("ogg"), "audio/ogg");
    expect(texto).toBe("bom dia");
    expect(
      generateTextMock,
      "o áudio chegou ao modelo de conversa — o caminho que recusa audio/ogg",
    ).not.toHaveBeenCalled();

    expect(chamadas, "a transcrição não saiu para a OpenRouter").toHaveLength(1);
    const { url, init } = ultimaChamada();
    expect(new URL(url).pathname).toBe("/api/v1/audio/transcriptions");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(BEARER + " " + CHAVE_ORG);
    const form = init.body as FormData;
    expect(form.get("model")).toBe("openai/whisper-large-v3");
    // O idioma do `.env` chega ao serviço, como chega nos degraus 1 e 2.
    expect(form.get("language")).toBe("pt");
    expect((form.get("file") as File).name).toBe("audio.ogg");
  });
});

describe("controles — os degraus de antes não mudaram de lugar", () => {
  beforeEach(() => {
    transcricaoDoEnv.apiKey = ""; transcricaoDoEnv.baseUrl = "";
    transcricaoDoEnv.model = "";
    transcricaoDoEnv.languages = "";
  });

  it("organização OpenRouter COM chave OpenAI continua no whisper-1 da OpenAI — ninguém troca de fornecedor numa atualização", async () => {
    const decisao = await decidirTranscricao({
      conversa: CONVERSA_OPENROUTER,
      chaveOpenai: async () => "chave-openai-de-controle",
    });
    expect(decisao.origem).toBe("padrao_openai_compativel");
    expect(decisao.anuncio.modelId).toBe("whisper-1");
  });

  it("o serviço de transcrição da instalação continua ANTES de tudo (#2171)", async () => {
    transcricaoDoEnv.apiKey = "chave-do-servico-da-instalacao";
    transcricaoDoEnv.model = "whisper-large-v3";
    const decisao = await decidirTranscricao({
      conversa: CONVERSA_OPENROUTER,
      chaveOpenai: async () => null,
    });
    expect(decisao.origem).toBe("servico_da_instalacao");
    // A escada SÓ ESCOLHE: a chamada sai quando o worker transcreve.
    await decisao.transcriber!.transcribe(Buffer.from("ogg"), "audio/ogg");
    expect(ultimaChamada().url).toContain("api.openai.com");
  });

  it("a conversa Google com `audio` continua transcrevendo pelo próprio modelo (#2171)", async () => {
    const decisao = await decidirTranscricao({
      conversa: { provider: "google", apiKey: "chave-google-de-controle", modelId: "gemini-3.5-flash" },
      chaveOpenai: async () => null,
    });
    expect(decisao.origem).toBe("modelo_da_organizacao");
    await decisao.transcriber!.transcribe(Buffer.from("ogg"), "audio/ogg");
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(chamadas, "o degrau do modelo não fala com /audio/transcriptions").toHaveLength(0);
  });

  it("conversa OpenRouter SEM modelo de áudio também transcreve — antes era `nada` com nota de falha", async () => {
    const decisao = await decidirTranscricao({
      conversa: { ...CONVERSA_OPENROUTER, modelId: "mistralai/mistral-7b" },
      chaveOpenai: async () => null,
    });
    expect(decisao.origem).toBe("padrao_openrouter");
    expect(await decisao.transcriber!.transcribe(Buffer.from("ogg"), "audio/ogg")).toBe("bom dia");
  });
});

describe("a instalação muda o destino e a atribuição, como no resto do produto", () => {
  it("OPENROUTER_BASE_URL aponta a transcrição para o gateway da variável", async () => {
    // A mesma régua de todo caminho OpenRouter (`openrouter-base-url-em-todo
    // -caminho.test.ts`): a constante lê a variável na importação, então o
    // módulo é reavaliado antes de decidir a escada.
    vi.stubEnv("OPENROUTER_BASE_URL", "https://meu-gateway.example.com/v1");
    vi.resetModules();
    const { decidirTranscricao: decidirDeNovo } = await import(
      "@/lib/messaging/media/escada-de-transcricao"
    );

    const decisao = await decidirDeNovo({
      conversa: CONVERSA_OPENROUTER,
      chaveOpenai: async () => null,
    });
    await decisao.transcriber!.transcribe(Buffer.from("ogg"), "audio/ogg");

    expect(new URL(ultimaChamada().url).host).toBe("meu-gateway.example.com");
  });

  it("os cabeçalhos de atribuição da OpenRouter saem da INSTALAÇÃO, nunca literais", async () => {
    // A mesma atribuição do caminho de chat (`openrouter-atribuicao.test.ts`):
    // sem env, nenhum header; com env, o valor de quem instalou.
    const decisao = await decidirTranscricao({
      conversa: CONVERSA_OPENROUTER,
      chaveOpenai: async () => null,
    });
    await decisao.transcriber!.transcribe(Buffer.from("ogg"), "audio/ogg");
    expect(ultimaChamada().init.headers).not.toHaveProperty("HTTP-Referer");
    expect(ultimaChamada().init.headers).not.toHaveProperty("X-Title");

    vi.stubEnv("OPENROUTER_APP_URL", "https://crm.exemplo.com.br");
    vi.stubEnv("OPENROUTER_APP_TITLE", "CRM da Exemplo");
    vi.resetModules();
    const { decidirTranscricao: decidirDeNovo } = await import(
      "@/lib/messaging/media/escada-de-transcricao"
    );
    const deNovo = await decidirDeNovo({
      conversa: CONVERSA_OPENROUTER,
      chaveOpenai: async () => null,
    });
    await deNovo.transcriber!.transcribe(Buffer.from("ogg"), "audio/ogg");
    expect(ultimaChamada().init.headers).toMatchObject({
      "HTTP-Referer": "https://crm.exemplo.com.br",
      "X-Title": "CRM da Exemplo",
    });
  });
});
