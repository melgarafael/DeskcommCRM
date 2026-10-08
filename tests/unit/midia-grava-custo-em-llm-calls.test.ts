import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as ModuloDeTranscricao from "@/lib/messaging/media/transcription";

/**
 * Visão e transcrição do worker de mídia saíam pagas e não deixavam linha em
 * `llm_calls` — a tabela que a tela de uso, Execuções e o teto de orçamento
 * leem. O que estes casos fixam: chamada que SAIU grava uma linha no ponto
 * certo, com a organização da linha do evento; chamada RECUSADA antes de sair
 * (destino interno, chave da instalação) não grava nada, porque não custou.
 *
 * Mesmo dublê de `midia-base-url-do-binding.test.ts`, mais a captura do insert
 * em `llm_calls`.
 */

const downloadMock = vi.fn();
const llmCallsInsertMock = vi.fn();
const factoryMock = vi.fn(() => "modelo-de-mentira");
const transcribeDoSvcMock = vi.fn(async () => "transcrição de mentira");

const dns = vi.hoisted(() => ({ resposta: [] as Array<{ address: string; family: number }> }));
vi.mock("node:dns/promises", () => {
  const lookup = vi.fn(async () => dns.resposta);
  return { lookup, default: { lookup } };
});

const BINDING = {
  provider: "anthropic",
  model_id: "claude-haiku-4-5",
  credential_id: "cred-1",
  base_url: null as string | null,
};
let bindingDaVez: typeof BINDING | null = BINDING;

let linhaDaMensagem = {
  id: "msg1",
  organization_id: "org1",
  type: "image" as string,
  media_mime: "image/jpeg",
  media_storage_path: "org1/conv1/msg1.jpg",
  media_derived_status: null as string | null,
};

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const linha =
        tabela === "ai_purpose_bindings" ? bindingDaVez : tabela === "agent_inbox_items" ? null : linhaDaMensagem;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const terminais: any = {
        maybeSingle: async () => ({ data: linha, error: null }),
        insert: async (row: Record<string, unknown>) => {
          if (tabela === "llm_calls") llmCallsInsertMock(row);
          return { error: null };
        },
        update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = new Proxy(terminais, {
        get: (alvo, prop) => (prop in alvo ? alvo[prop as keyof typeof alvo] : () => chain),
      });
      return chain;
    },
    storage: { from: () => ({ download: downloadMock }) },
  }),
}));

vi.mock("@/lib/messaging/media/derive", () => ({
  deriveMediaText: vi.fn(async () => "derivado de mentira"),
}));

const credencial = vi.hoisted(() => ({
  origemDaChave: "credencial_da_organizacao" as "credencial_da_organizacao" | "chave_da_instalacao",
  /**
   * `null` = a conversa é a Anthropic de sempre e há chave OpenAI (degrau 2).
   * Preenchido = a conversa é este modelo Google, que declara `audio`, e não há
   * chave OpenAI nenhuma — a escada desce ao degrau 3.
   */
  conversaGoogle: null as string | null,
}));
vi.mock("@/lib/agent-engine/edge/llm/credentials", () => ({
  resolveOrgLlmConfig: vi.fn(async (_db: unknown, _cfg: unknown, _org: string, override?: { provider?: string }) => {
    if (credencial.conversaGoogle && override?.provider === "openai") throw new Error("sem credencial openai");
    return {
      provider: credencial.conversaGoogle ? "google" : "anthropic",
      apiKey: "chave-do-binding",
      origemDaChave: credencial.origemDaChave,
      defaultModel: credencial.conversaGoogle ?? "claude-haiku-4-5",
      params: {},
      enabledModels: [],
      orcamento: { modo: "off", tetoCents: 0, efetivoEm: null, limiarPct: 80 },
      orcamentoIndisponivelPorque: null,
    };
  }),
}));

vi.mock("@/lib/agent-engine/edge/llm/providers", () => ({
  createDefaultRegistry: () => ({
    anthropic: factoryMock,
    openai: factoryMock,
    openrouter: factoryMock,
    google: factoryMock,
  }),
}));

vi.mock("@/lib/ai/pontos/capacidade-em-vigor", () => ({
  visaoEmVigor: vi.fn(async () => ({ enxerga: true, sabemos: true })),
}));

vi.mock("ai", () => ({
  generateText: vi.fn(async () => ({
    text: "descrição de mentira",
    usage: {
      inputTokens: 1200,
      outputTokens: 40,
      inputTokenDetails: { noCacheTokens: 1200, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
  })),
}));

vi.mock("@/lib/messaging/media/transcription", async (importOriginal) => ({
  ...(await importOriginal<typeof ModuloDeTranscricao>()),
  apiTranscriptionProvider: () => ({ transcribe: transcribeDoSvcMock }),
}));

const transcricaoDoEnv = vi.hoisted(() => ({ apiKey: "", baseUrl: "" }));
vi.mock("@/lib/env", async (importOriginal) => {
  const real = await importOriginal<{ env: Env }>();
  return {
    env: {
      ...real.env,
      get TRANSCRIPTION_API_KEY() {
        return transcricaoDoEnv.apiKey;
      },
      get TRANSCRIPTION_BASE_URL() {
        return transcricaoDoEnv.baseUrl;
      },
      TRANSCRIPTION_MODEL: "",
      TRANSCRIPTION_LANGUAGES: "",
      IA_DESTINOS_INTERNOS_PERMITIDOS: "",
    },
  };
});

import { deriveMessageMedia } from "@/workers/media-derive-worker";
import { esquecerDestinosInternos } from "@/lib/automation/destinos-internos-autorizados";
import { PONTO_TRANSCRICAO_DE_AUDIO, PONTO_VISAO_DE_IMAGEM } from "@/lib/ai/pontos/registro";
import { deriveMediaText, type DeriveDeps } from "@/lib/messaging/media/derive";
import type { Env } from "@/lib/env";

function eventRow() {
  return {
    id: "ev1",
    organization_id: "org1",
    event_type: "media.derive_requested",
    entity_kind: "message",
    entity_id: "msg1",
    payload: { message_id: "msg1" },
    metadata: {},
    consumed_by: [],
    attempts: 0,
  };
}

function depsDaChamada(): DeriveDeps {
  const deps = vi.mocked(deriveMediaText).mock.calls[0]?.[3];
  if (!deps) throw new Error("deriveMediaText não recebeu deps: a derivação parou antes");
  return deps;
}

function comAudio(): void {
  linhaDaMensagem = { ...linhaDaMensagem, type: "audio", media_mime: "audio/ogg", media_storage_path: "org1/conv1/msg1.ogg" };
}

beforeEach(() => {
  vi.clearAllMocks();
  esquecerDestinosInternos();
  dns.resposta = [{ address: "93.184.216.34", family: 4 }];
  credencial.origemDaChave = "credencial_da_organizacao";
  credencial.conversaGoogle = null;
  bindingDaVez = BINDING;
  transcricaoDoEnv.apiKey = "";
  transcricaoDoEnv.baseUrl = "";
  linhaDaMensagem = {
    id: "msg1",
    organization_id: "org1",
    type: "image",
    media_mime: "image/jpeg",
    media_storage_path: "org1/conv1/msg1.jpg",
    media_derived_status: null,
  };
  downloadMock.mockResolvedValue({ data: { arrayBuffer: async () => new ArrayBuffer(8) }, error: null });
});

describe("worker de mídia: chamada paga grava em llm_calls", () => {
  it("visão que saiu grava uma linha no ponto da visão, com tokens e custo da tabela de preços", async () => {
    await deriveMessageMedia(eventRow());
    await depsDaChamada().describeImage(Buffer.from("jpeg"), "image/jpeg");

    expect(factoryMock).toHaveBeenCalled();
    expect(llmCallsInsertMock).toHaveBeenCalledTimes(1);
    const linha = llmCallsInsertMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(linha).toMatchObject({
      organization_id: "org1",
      purpose: PONTO_VISAO_DE_IMAGEM,
      provider: "anthropic",
      model: "claude-haiku-4-5",
      input_tokens: 1200,
      output_tokens: 40,
      status: "ok",
    });
    // haiku-4-5: 1 USD/MTok de entrada, 5 de saída → (1200×1 + 40×5)/1e6 USD
    expect(linha.cost_cents).toBeCloseTo(((1200 * 1 + 40 * 5) / 1_000_000) * 100, 10);
    expect(typeof linha.latency_ms).toBe("number");
  });

  it("visão recusada por destino interno não grava linha", async () => {
    bindingDaVez = { ...BINDING, base_url: "http://169.254.169.254/v1" };

    await deriveMessageMedia(eventRow());
    await depsDaChamada().describeImage(Buffer.from("jpeg"), "image/jpeg");

    expect(factoryMock).not.toHaveBeenCalled();
    expect(llmCallsInsertMock).not.toHaveBeenCalled();
  });

  it("visão recusada por endereço da empresa com chave da instalação não grava linha", async () => {
    credencial.origemDaChave = "chave_da_instalacao";
    bindingDaVez = { ...BINDING, base_url: "https://gateway.publico.exemplo/v1" };

    await deriveMessageMedia(eventRow());
    await depsDaChamada().describeImage(Buffer.from("jpeg"), "image/jpeg");

    expect(factoryMock).not.toHaveBeenCalled();
    expect(llmCallsInsertMock).not.toHaveBeenCalled();
  });

  it("transcrição que saiu grava uma linha no ponto do áudio, com custo desconhecido (null, nunca 0)", async () => {
    comAudio();

    await deriveMessageMedia(eventRow());
    await depsDaChamada().transcriber.transcribe(Buffer.from("ogg"), "audio/ogg");

    expect(transcribeDoSvcMock).toHaveBeenCalled();
    expect(llmCallsInsertMock).toHaveBeenCalledTimes(1);
    expect(llmCallsInsertMock.mock.calls[0]![0]).toMatchObject({
      organization_id: "org1",
      purpose: PONTO_TRANSCRICAO_DE_AUDIO,
      provider: "openai",
      model: "whisper-1",
      input_tokens: 0,
      output_tokens: 0,
      cost_cents: null,
      status: "ok",
    });
  });

  it("transcrição pelo serviço grava o degrau da escada, que é o que a separa do furo de medição", async () => {
    comAudio();

    await deriveMessageMedia(eventRow());
    await depsDaChamada().transcriber.transcribe(Buffer.from("ogg"), "audio/ogg");

    expect(llmCallsInsertMock.mock.calls[0]![0]).toMatchObject({ origem_da_escolha: "padrao_openai_compativel" });
  });

  it("transcrição pelo modelo da organização (degrau 3) grava tokens e o custo da tabela de preços", async () => {
    comAudio();
    credencial.conversaGoogle = "gemini-2.5-flash";
    bindingDaVez = null;

    await deriveMessageMedia(eventRow());
    const texto = await depsDaChamada().transcriber.transcribe(Buffer.from("ogg"), "audio/ogg");

    // O áudio foi ao MODELO, não ao serviço de transcrição.
    expect(transcribeDoSvcMock).not.toHaveBeenCalled();
    expect(texto).toBe("descrição de mentira");
    expect(llmCallsInsertMock).toHaveBeenCalledTimes(1);
    const linha = llmCallsInsertMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(linha).toMatchObject({
      organization_id: "org1",
      purpose: PONTO_TRANSCRICAO_DE_AUDIO,
      provider: "google",
      model: "gemini-2.5-flash",
      origem_da_escolha: "modelo_da_organizacao",
      input_tokens: 1200,
      output_tokens: 40,
      status: "ok",
    });
    // gemini-2.5-flash: 0,30 USD/MTok de entrada, 2,50 de saída
    expect(linha.cost_cents).toBeCloseTo(((1200 * 0.3 + 40 * 2.5) / 1_000_000) * 100, 10);
  });

  it("degrau 3 com modelo fora da tabela de preços grava os tokens e custo null — nunca 0", async () => {
    comAudio();
    credencial.conversaGoogle = "gemini-modelo-que-ninguem-precificou";
    bindingDaVez = null;

    await deriveMessageMedia(eventRow());
    await depsDaChamada().transcriber.transcribe(Buffer.from("ogg"), "audio/ogg");

    expect(llmCallsInsertMock.mock.calls[0]![0]).toMatchObject({
      origem_da_escolha: "modelo_da_organizacao",
      input_tokens: 1200,
      cost_cents: null,
    });
  });

  it("transcrição recusada por destino interno não grava linha", async () => {
    comAudio();
    transcricaoDoEnv.apiKey = "chave-do-servico";
    transcricaoDoEnv.baseUrl = "http://169.254.169.254/v1";

    await deriveMessageMedia(eventRow());
    await depsDaChamada().transcriber.transcribe(Buffer.from("ogg"), "audio/ogg");

    expect(transcribeDoSvcMock).not.toHaveBeenCalled();
    expect(llmCallsInsertMock).not.toHaveBeenCalled();
  });

  it("transcrição que falha no provedor grava a linha de erro e o erro continua subindo", async () => {
    comAudio();
    transcribeDoSvcMock.mockRejectedValueOnce(new Error("transcription_401"));

    await deriveMessageMedia(eventRow());
    await expect(depsDaChamada().transcriber.transcribe(Buffer.from("ogg"), "audio/ogg")).rejects.toThrow(
      "transcription_401",
    );

    expect(llmCallsInsertMock).toHaveBeenCalledTimes(1);
    const linha = llmCallsInsertMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(linha).toMatchObject({
      organization_id: "org1",
      purpose: PONTO_TRANSCRICAO_DE_AUDIO,
      status: "erro",
      cost_cents: null,
      input_tokens: 0,
    });
    expect(String(linha.error_message)).toContain("transcription_401");
    expect(typeof linha.error_code).toBe("string");
  });

  it("visão que falha no provedor grava a linha de erro e o erro continua subindo", async () => {
    const { generateText } = await import("ai");
    vi.mocked(generateText).mockRejectedValueOnce(Object.assign(new Error("invalid x-api-key"), { statusCode: 401 }));

    await deriveMessageMedia(eventRow());
    await expect(depsDaChamada().describeImage(Buffer.from("jpeg"), "image/jpeg")).rejects.toThrow("invalid x-api-key");

    expect(llmCallsInsertMock).toHaveBeenCalledTimes(1);
    expect(llmCallsInsertMock.mock.calls[0]![0]).toMatchObject({
      organization_id: "org1",
      purpose: PONTO_VISAO_DE_IMAGEM,
      status: "erro",
      cost_cents: null,
      http_status: 401,
    });
  });
});

describe("as constantes de purpose da mídia casam com o registro de pontos", () => {
  it("cada uma é o id de uma entrada — senão a linha em llm_calls fica sem rótulo em Execuções", async () => {
    const { PONTO_POR_ID } = await import("@/lib/ai/pontos/registro");
    expect(PONTO_POR_ID.get(PONTO_TRANSCRICAO_DE_AUDIO)?.registraEm).toBe("llm_calls");
    expect(PONTO_POR_ID.get(PONTO_VISAO_DE_IMAGEM)).toBeDefined();
  });
});
