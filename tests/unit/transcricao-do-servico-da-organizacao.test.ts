/**
 * #4713 — A TRANSCRIÇÃO PODE SER DA ORGANIZAÇÃO, NÃO SÓ DA INSTALAÇÃO.
 *
 * O que a `main` faz hoje: o `.env` da instalação (`TRANSCRIPTION_API_KEY`) é
 * o degrau 1 e vence TODOS os degraus da organização. Uma instalação com mais
 * de uma empresa que aponta o Whisper próprio no `.env` transcreve o áudio de
 * todas elas, e a empresa que cadastrou o próprio serviço não tem como pedir o
 * dela pela tela: o ponto `transcricao_de_audio` só oferecia "Automático" e
 * "ElevenLabs (Scribe)".
 *
 * Este arquivo prova o degrau 0b que passou a existir — o serviço compatível
 * com OpenAI ESCOLHIDO pela organização, com endereço, modelo, chave e idioma
 * dela — e os dois controles que não podiam mudar de lugar:
 *
 *   (a) a escolha da organização vence o `.env` (era o contrário);
 *   (b) o idioma é o da ORGANIZAÇÃO, não o `TRANSCRIPTION_LANGUAGES` global;
 *   (c) escolha incompleta recusa com motivo legível e cai para o degrau
 *       seguinte — nunca chama um serviço pela metade em silêncio;
 *   (d) "Automático" continua usando o `.env`, quando ele existe;
 *   (e) o ElevenLabs (Scribe) continua sendo o degrau 0, como hoje.
 *
 * O `fetch` é dublado e o corpo sai em `FormData`: as asserções são sobre o
 * pedido REAL que iria ao serviço (endereço, modelo, idioma e chave), não
 * sobre a intenção da escada.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as ModuloDeEnv from "@/lib/env";
import {
  RECUSAS_DA_TRANSCRICAO,
  decidirTranscricao,
} from "@/lib/messaging/media/escada-de-transcricao";

/**
 * A escada lê os knobs pela régua `env` (`lib/env.ts`), nunca por
 * `process.env` (#855/#964) — `vi.stubEnv` não alcança esse caminho.
 */
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

/** Toda chamada que sai: destino e corpo. */
let chamadas: { url: string; init: RequestInit }[] = [];

function ultimaChamada() {
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
});

/** Chaves de CONTROLE: valor inventado, nunca um segredo de verdade. */
const CHAVE_DA_ORGANIZACAO = "chave-do-gateway-da-organizacao";
const CHAVE_DA_INSTALACAO = "chave-do-servico-da-instalacao";
const ENDERECO_DA_ORGANIZACAO = "https://gateway.da-organizacao.example/v1";

/** O degrau 0b como o worker o monta: binding da organização + credencial `custom`. */
const PEDIDO_DA_ORGANIZACAO = {
  apiKey: CHAVE_DA_ORGANIZACAO,
  baseUrl: ENDERECO_DA_ORGANIZACAO,
  modelId: "whisper-large-v3",
  languages: ["es"],
} as const;

describe("#4713 — serviço compatível com OpenAI escolhido pela organização", () => {
  beforeEach(() => {
    // O caso da issue: a instalação JÁ tem serviço configurado (9Router/Groq) e
    // o idioma dela é `en`. É contra este `.env` que a escolha da organização
    // precisa vencer.
    transcricaoDoEnv.apiKey = CHAVE_DA_INSTALACAO;
    transcricaoDoEnv.baseUrl = "https://gateway.da-instalacao.example/v1";
    transcricaoDoEnv.model = "whisper-large-v3-turbo";
    transcricaoDoEnv.languages = "en";
  });

  it("(a) a escolha da organização vence o TRANSCRIPTION_API_KEY da instalação", async () => {
    const decisao = await decidirTranscricao({
      servicoCompativelEscolhido: async () => ({ ...PEDIDO_DA_ORGANIZACAO }),
      chaveOpenai: async () => null,
    });

    // É ESTA a asserção vermelha antes do degrau 0b: a escada devolvia
    // `servico_da_instalacao` e o áudio de todas as organizações ia para o
    // serviço do `.env`.
    expect(
      decisao.origem,
      "a escolha da organização perdeu para o .env — o degrau 0b não está antes do degrau 1",
    ).toBe("servico_compativel_da_organizacao");
    expect(decisao.motivo).toBe(
      "a organização escolheu o serviço compatível com OpenAI deste ponto, e ele ouve os áudios com o endereço, o modelo e a chave dela",
    );
    // A tela anuncia o degrau que RODA: o provedor personalizado e o modelo
    // dela, não o `whisper-1` nem o modelo do `.env`.
    expect(decisao.anuncio).toEqual({ provider: "custom", modelId: "whisper-large-v3" });

    expect(await decisao.transcriber!.transcribe(Buffer.from("ogg"), "audio/ogg")).toBe("bom dia");
    const { url, init } = ultimaChamada();
    expect(new URL(url).host).toBe("gateway.da-organizacao.example");
    expect(url).toContain("/v1/audio/transcriptions");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${CHAVE_DA_ORGANIZACAO}`,
    );
    const form = init.body as FormData;
    expect(form.get("model")).toBe("whisper-large-v3");
    expect((form.get("file") as File).name).toBe("audio.ogg");
  });

  it("(b) o idioma da organização é usado, não o TRANSCRIPTION_LANGUAGES da instalação", async () => {
    const decisao = await decidirTranscricao({
      servicoCompativelEscolhido: async () => ({ ...PEDIDO_DA_ORGANIZACAO }),
      chaveOpenai: async () => null,
    });

    await decisao.transcriber!.transcribe(Buffer.from("ogg"), "audio/ogg");
    const form = ultimaChamada().init.body as FormData;
    // O `.env` diz `en`; a organização diz `es`. Antes do conserto, o áudio
    // dela era transcrito em inglês por causa do global.
    expect(
      form.get("language"),
      "o idioma global da instalação vazou para o serviço da organização",
    ).toBe("es");
    expect(form.get("languages[]")).toBeNull();
  });

  it("(c) escolha sem base_url recusa com motivo legível e cai para o próximo degrau", async () => {
    const decisao = await decidirTranscricao({
      servicoCompativelEscolhido: async () => ({ ...PEDIDO_DA_ORGANIZACAO, baseUrl: "   " }),
      chaveOpenai: async () => null,
    });

    // Não chama nada pela metade: a decisão não fez NENHUMA requisição.
    expect(chamadas, "a escada chamou um serviço com a escolha incompleta").toHaveLength(0);
    // Cai para o degrau seguinte — o serviço da instalação, que existe.
    expect(decisao.origem).toBe("servico_da_instalacao");
    // E a recusa chega legível a quem configurou (log do worker e cartão).
    expect(decisao.recusas).toEqual([RECUSAS_DA_TRANSCRICAO.servicoSemEndereco]);
    expect(decisao.recusas[0]).toMatch(/endereço \(base URL\)/);

    // O degrau que assumiu é o do `.env` — o áudio continua sendo transcrito.
    await decisao.transcriber!.transcribe(Buffer.from("ogg"), "audio/ogg");
    expect(new URL(ultimaChamada().url).host).toBe("gateway.da-instalacao.example");
  });

  it("(c2) escolha sem modelo também recusa com motivo legível, e não inventa whisper-1", async () => {
    const decisao = await decidirTranscricao({
      servicoCompativelEscolhido: async () => ({ ...PEDIDO_DA_ORGANIZACAO, modelId: "" }),
      chaveOpenai: async () => null,
    });

    expect(chamadas).toHaveLength(0);
    expect(decisao.origem).toBe("servico_da_instalacao");
    expect(decisao.recusas).toEqual([RECUSAS_DA_TRANSCRICAO.servicoSemModelo]);
  });
});

describe("#4713 — controles: o que já funcionava continua no mesmo lugar", () => {
  it("(d) 'Automático' (nenhuma escolha) continua usando o .env da instalação", async () => {
    transcricaoDoEnv.apiKey = CHAVE_DA_INSTALACAO;
    transcricaoDoEnv.baseUrl = "";
    transcricaoDoEnv.model = "";
    transcricaoDoEnv.languages = "pt";

    const decisao = await decidirTranscricao({
      servicoCompativelEscolhido: async () => null,
      chaveOpenai: async () => null,
    });

    expect(decisao.origem).toBe("servico_da_instalacao");
    expect(decisao.recusas).toEqual([]);
    expect(decisao.anuncio).toEqual({ provider: "openai", modelId: "whisper-1" });
    await decisao.transcriber!.transcribe(Buffer.from("ogg"), "audio/ogg");
    expect(new URL(ultimaChamada().url).host).toBe("api.openai.com");
    expect((ultimaChamada().init.body as FormData).get("language")).toBe("pt");
  });

  it("(e) o ElevenLabs (Scribe) continua sendo o degrau 0 — inclusive contra o serviço novo", async () => {
    transcricaoDoEnv.apiKey = CHAVE_DA_INSTALACAO;
    transcricaoDoEnv.languages = "en";

    const decisao = await decidirTranscricao({
      elevenlabsEscolhido: async () => ({ apiKey: "chave-elevenlabs-de-controle", modelId: "scribe_v1" }),
      servicoCompativelEscolhido: async () => ({ ...PEDIDO_DA_ORGANIZACAO }),
      chaveOpenai: async () => null,
    });

    // O Scribe é escolha explícita e vem ANTES do serviço compatível: os dois
    // são o mesmo menu, e o comportamento do Scribe não muda nesta issue.
    expect(decisao.origem).toBe("elevenlabs_escolhido");
    expect(decisao.anuncio).toEqual({ provider: "elevenlabs", modelId: "scribe_v1" });
    await decisao.transcriber!.transcribe(Buffer.from("ogg"), "audio/ogg");
    expect((ultimaChamada().init.headers as Record<string, string>)["xi-api-key"]).toBe(
      "chave-elevenlabs-de-controle",
    );
    expect(chamadas).toHaveLength(1);
  });
});
