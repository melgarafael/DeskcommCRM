/**
 * Transcrição de áudio plugável (Onda 3). Default: API speech-to-text
 * OpenAI-compatível (Whisper) via BYOK. O derivado é texto → alimenta QUALQUER
 * modelo de chat (camada universal). Um backend mlx-whisper local implementa a
 * mesma interface para self-host em Apple Silicon (fora deste MVP).
 */
import type { TokenUsage } from "@/lib/agent-engine/edge/llm/pricing";

export interface TranscriptionProvider {
  transcribe(audio: Buffer, mime: string): Promise<string>;
  /**
   * Medição devolvida pelo fornecedor. O modelo de conversa traz tokens;
   * o serviço OpenRouter pode trazer o custo em USD, convertido para centavos.
   * Ausência de custo continua null, nunca uma estimativa de preço.
   */
  transcribeMedindo?(audio: Buffer, mime: string): Promise<{
    texto: string;
    uso: TokenUsage | null;
    custoCents?: number | null;
  }>;
}

/**
 * Os degraus da escada que chamam `/v1/audio/transcriptions` (abaixo). Esses
 * serviços podem informar o custo da chamada, mas não usam a tabela de preço
 * por tokens do modelo de conversa. Quando o serviço não informa custo, fica
 * null. Esta lista em `origem_da_escolha` separa essa ausência do preço de LLM
 * desconhecido no aviso de orçamento (`lib/ai/budget/check.ts`).
 *
 * `padrao_openrouter` (#3382) é o degrau 3: a própria OpenRouter transcreve
 * com a chave da conversa. `usage.cost`, quando válido, mede USD da chamada;
 * sem esse campo, o custo continua desconhecido.
 */
export const ORIGENS_DA_TRANSCRICAO_POR_SERVICO = [
  "servico_da_instalacao",
  "padrao_openai_compativel",
  "padrao_openrouter",
] as const;

export interface TranscriptionCreds {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /**
   * Idiomas esperados no áudio (ISO-639-1). Vazio = o serviço detecta sozinho,
   * que é o comportamento de sempre.
   *
   * Existe porque a detecção sozinha ALUCINA em áudio curto, com ruído ou com
   * sotaque regional. Medido numa loja em espanhol (26/09/2026, 14 áudios
   * reais de clientes): `whisper-1` sem idioma devolveu "Thanks for
   * watching!" para um áudio sem fala, uma frase em GREGO para "mejor dejamos
   * ahí nomás" (o cliente cancelando) e "ya es claro" para "ya es caro" — e o
   * agente respondeu ao que leu. Com o idioma declarado, `gpt-transcribe`
   * acertou os três e devolveu vazio para o áudio sem fala.
   */
  languages?: readonly string[];
  /**
   * Cabeçalhos EXTRA da chamada, por cima do `Authorization` (#3382: os de
   * atribuição da OpenRouter, `HTTP-Referer`/`X-Title`, que a própria
   * OpenRouter documenta como opcionais). Nulo/ausente = só o Authorization de
   * sempre; o Authorization NUNCA é sobrescrevível por aqui.
   */
  headers?: Record<string, string> | undefined;
  /** Contrato do fornecedor, sem alterar o teto global de mídia. */
  maxAudioBytes?: number;
  /** Apenas no contrato OpenRouter: usage.cost é o total da chamada em USD. */
  medirCustoEmUsd?: boolean;
}

export class TranscriptionTooLargeError extends Error {
  override readonly name = "transcription_audio_too_large";
  constructor(readonly limitBytes: number) {
    super("transcription_audio_too_large");
  }
}

const DEFAULT_BASE = "https://api.openai.com";
const DEFAULT_MODEL = "whisper-1";

/**
 * O modelo que transcreve de verdade: o de `TRANSCRIPTION_MODEL` quando a
 * instalação o define, senão `whisper-1`. Uma função só para o worker (que
 * transcreve) e a tela de Provedores (que ANUNCIA o modelo) — duas leituras
 * separadas fariam a tela dizer `whisper-1` com outro modelo em uso.
 *
 * Com `TRANSCRIPTION_BASE_URL` preenchido e sem `TRANSCRIPTION_API_KEY`, o
 * modelo do `.env` foi escrito para OUTRO serviço (o exemplo do `.env.example`
 * é `whisper-large-v3`, do Groq), e a chamada vai à OpenAI com a chave da
 * organização: pedir esse modelo lá quebraria no update uma transcrição que
 * funciona com `whisper-1`. Nesse caso vale `whisper-1`, como antes.
 */
export function modeloDeTranscricaoEmVigor(doAmbiente: {
  model: string | undefined;
  apiKey: string | undefined;
  baseUrl: string | undefined;
}): string {
  const m = (doAmbiente.model ?? "").trim();
  const modeloDeOutroServico = (doAmbiente.baseUrl ?? "").trim() !== "" && (doAmbiente.apiKey ?? "").trim() === "";
  return m === "" || modeloDeOutroServico ? DEFAULT_MODEL : m;
}

/**
 * `TRANSCRIPTION_LANGUAGES` ("es" ou "pt,es") → lista de códigos. Tolerante de
 * propósito: é variável opcional de `.env`, e grafia errada não pode derrubar
 * o worker — o código que não tem forma de ISO-639 fica de fora e o resto vale.
 */
export function idiomasDaTranscricao(bruto: string | undefined): string[] {
  return (bruto ?? "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter((x) => /^[a-z]{2,3}$/.test(x));
}

/**
 * Como o idioma vai no corpo, conforme o modelo. Os modelos novos da OpenAI
 * (`gpt-transcribe`, `gpt-live-transcribe`) recebem a LISTA `languages[]`; os
 * anteriores (`whisper-1`, `gpt-4o-*-transcribe`, os Whisper de terceiros)
 * recebem UM `language`. Mandar os dois é recusado pela API.
 */
export function camposDeIdioma(model: string, languages: readonly string[]): [string, string][] {
  if (languages.length === 0) return [];
  return /^gpt-(live-)?transcribe\b/.test(model)
    ? languages.map((l): [string, string] => ["languages[]", l])
    : [["language", languages[0]!]];
}

function extFor(mime: string): string {
  const base = mime.split(";")[0]!.trim().toLowerCase();
  if (base.includes("ogg")) return "ogg";
  if (base.includes("mpeg") || base.includes("mp3")) return "mp3";
  if (base.includes("mp4") || base.includes("m4a")) return "m4a";
  if (base.includes("webm")) return "webm";
  if (base.includes("wav")) return "wav";
  return "bin";
}

export function apiTranscriptionProvider(
  creds: TranscriptionCreds,
  fetchImpl: typeof fetch = fetch,
): TranscriptionProvider {
  const rawBase = (creds.baseUrl ?? DEFAULT_BASE).trim().replace(/\/+$/, "");
  const base = rawBase.replace(/\/v1$/, "");
  const model = creds.model ?? DEFAULT_MODEL;
  const transcrever = async (audio: Buffer, mime: string) => {
    if (creds.maxAudioBytes !== undefined && audio.byteLength > creds.maxAudioBytes) {
      throw new TranscriptionTooLargeError(creds.maxAudioBytes);
    }
    const form = new FormData();
    form.append("model", model);
    form.append(
      "file",
      new Blob([new Uint8Array(audio)], { type: mime.split(";")[0]!.trim() }),
      `audio.${extFor(mime)}`,
    );
    for (const [campo, valor] of camposDeIdioma(model, creds.languages ?? [])) form.append(campo, valor);
    const res = await fetchImpl(`${base}/v1/audio/transcriptions`, {
      method: "POST",
      headers: { ...creds.headers, Authorization: `Bearer ${creds.apiKey}` },
      body: form,
    });
    if (!res.ok) throw new Error(`transcription_${res.status}`);
    const json = (await res.json()) as { text?: string; usage?: { cost?: unknown } };
    const custoEmUsd = json.usage?.cost;
    const custoCents = typeof custoEmUsd === "number" && Number.isFinite(custoEmUsd) && custoEmUsd >= 0
      && Number.isFinite(custoEmUsd * 100) ? custoEmUsd * 100 : null;
    return { texto: json.text ?? "", uso: null, custoCents };
  };
  return {
    transcribe: async (audio, mime) => (await transcrever(audio, mime)).texto,
    ...(creds.medirCustoEmUsd ? { transcribeMedindo: transcrever } : {}),
  };
}
