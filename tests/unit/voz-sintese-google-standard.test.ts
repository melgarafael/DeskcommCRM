/**
 * SÍNTESE DE VOZ — Google Cloud Text-to-Speech, só voz Standard em pt-BR
 * (`lib/agent-engine/edge/voz/sintese.ts`, regra em `vozes.ts`).
 *
 * O `fetch` é um dublê: nenhuma requisição sai, e a chave é fictícia. O que se
 * prende: a família de voz barata é a única aceita, a chave vai no cabeçalho e
 * nunca na URL nem no erro, o formato é o da nota de voz, e nenhum desfecho sem
 * áudio vira áudio vazio.
 */
import { describe, expect, it, vi } from "vitest";

import {
  configDaVoz,
  criarSintetizador,
  ENDPOINT_DA_SINTESE,
  FalhaDaVoz,
  VOZ_PADRAO,
} from "@/lib/agent-engine/edge/voz/sintese";

const CHAVE = "chave-ficticia-de-teste";

function respostaJson(corpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("configDaVoz — só a família Standard", () => {
  it("sem chave, o recurso está desligado", () => {
    expect(configDaVoz({})).toEqual({ ok: false, code: "nao_configurada" });
    expect(configDaVoz({ GOOGLE_TTS_API_KEY: "   " })).toEqual({ ok: false, code: "nao_configurada" });
  });

  it("voz vazia vale a padrão, Standard", () => {
    expect(VOZ_PADRAO).toBe("pt-BR-Standard-A");
    expect(configDaVoz({ GOOGLE_TTS_API_KEY: CHAVE })).toEqual({
      ok: true,
      config: { apiKey: CHAVE, voz: "pt-BR-Standard-A" },
    });
    expect(configDaVoz({ GOOGLE_TTS_API_KEY: CHAVE, GOOGLE_TTS_VOICE: "pt-BR-Standard-C" })).toMatchObject({
      ok: true,
      config: { voz: "pt-BR-Standard-C" },
    });
  });

  it.each([
    "pt-BR-Wavenet-A",
    "pt-BR-Neural2-A",
    "pt-BR-Studio-B",
    "pt-BR-Chirp3-HD-Achernar",
    "Kore",
    "gemini-2.5-flash-tts",
    "en-US-Standard-A",
    "pt-BR-Standard-",
  ])("recusa voz fora da família barata: %s", (voz) => {
    expect(configDaVoz({ GOOGLE_TTS_API_KEY: CHAVE, GOOGLE_TTS_VOICE: voz })).toEqual({
      ok: false,
      code: "voz_nao_permitida",
    });
  });
});

describe("criarSintetizador — a requisição e os desfechos", () => {
  const config = { apiKey: CHAVE, voz: "pt-BR-Standard-A" };

  it("pede OGG/Opus em pt-BR, com a chave no cabeçalho e nunca na URL", async () => {
    const audio = Buffer.from("OggS-fake-opus");
    const fetchImpl = vi.fn(async () => respostaJson({ audioContent: audio.toString("base64") }));
    const sintetizar = criarSintetizador(config, { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(await sintetizar("  Olá, tudo bem?  ")).toEqual(audio);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(ENDPOINT_DA_SINTESE);
    expect(url).not.toContain(CHAVE);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe(CHAVE);
    expect(JSON.parse(init.body as string)).toEqual({
      input: { text: "Olá, tudo bem?" },
      voice: { languageCode: "pt-BR", name: "pt-BR-Standard-A" },
      audioConfig: { audioEncoding: "OGG_OPUS" },
    });
  });

  it("erro HTTP vira FalhaDaVoz com o status, sem a chave na mensagem", async () => {
    const fetchImpl = vi.fn(async () => respostaJson({ error: { message: `bad key ${CHAVE}` } }, 403));
    const sintetizar = criarSintetizador(config, { fetchImpl: fetchImpl as unknown as typeof fetch });
    const err = await sintetizar("Oi").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FalhaDaVoz);
    expect(err).toMatchObject({ code: "http", status: 403 });
    expect(String((err as Error).message)).not.toContain(CHAVE);
  });

  it("falha de rede vira `rede`, sem ecoar a causa", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error(`connect ECONNREFUSED ${CHAVE}`);
    });
    const sintetizar = criarSintetizador(config, { fetchImpl: fetchImpl as unknown as typeof fetch });
    const err = await sintetizar("Oi").catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "rede" });
    expect(String((err as Error).message)).not.toContain(CHAVE);
  });

  it.each([
    ["sem audioContent", { foo: 1 }, "resposta_invalida"],
    ["audioContent vazio", { audioContent: "" }, "resposta_invalida"],
  ])("%s: nunca devolve áudio vazio", async (_n, corpo, code) => {
    const fetchImpl = vi.fn(async () => respostaJson(corpo));
    const sintetizar = criarSintetizador(config, { fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(sintetizar("Oi")).rejects.toMatchObject({ code });
  });

  it("texto vazio ou longo demais não chega à API", async () => {
    const fetchImpl = vi.fn();
    const sintetizar = criarSintetizador(config, { fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(sintetizar("   ")).rejects.toMatchObject({ code: "texto_vazio" });
    // 1600 caracteres acentuados = 3200 bytes; 2300 = 4600 bytes (acima do teto em BYTES).
    await expect(sintetizar("é".repeat(2300))).rejects.toMatchObject({ code: "texto_longo" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
