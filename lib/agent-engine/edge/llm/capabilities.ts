/**
 * Capability registry model-agnóstico (Onda 3). Decide se a mídia do turno vai
 * como PARTE NATIVA (image/file) além do derivado textual. É metadata, não um
 * gate de correção: o derivado universal sempre existe, então um modelo
 * desconhecido (default {false,false}) ainda "vê" a mídia via texto.
 *
 * Estender = uma linha (novo provider ou override de modelo). Conservador por
 * construção: só afirma nativo para o que sabemos que funciona.
 */
export interface ModelCapabilities {
  image: boolean;
  pdf: boolean;
}

const NATIVE: ModelCapabilities = { image: true, pdf: true };
const NONE: ModelCapabilities = { image: false, pdf: false };

// Famílias flagship dos 3 providers aceitam imagem+pdf via content parts da AI SDK.
const PROVIDER_DEFAULT: Record<string, ModelCapabilities> = {
  anthropic: NATIVE,
  openai: NATIVE,
  google: NATIVE,
};

/**
 * Provedores em que a capacidade é do MODELO, não do provedor.
 *
 * Na OpenRouter, `openai/gpt-4o` enxerga imagem e `mistralai/mistral-7b` não —
 * o provedor é um roteador, e perguntar "openrouter enxerga imagem?" não tem
 * resposta. Enquanto ela caía no default desconhecido, `modelCapabilities`
 * devolvia `image: false` para tudo: o comprovante do cliente virava marcador
 * e o aviso na Central afirmava "o modelo openai/gpt-4o não enxerga imagens" —
 * uma frase falsa, gravada para o operador.
 *
 * O id do modelo carrega o fabricante no prefixo, e é dele que a capacidade sai.
 */
const ROTEADORES = new Set(["openrouter", "requesty", "custom"]);

/**
 * Este provedor é um ROTEADOR (revende modelos de vários fabricantes)?
 *
 * Importa para quem compõe esta resposta com o catálogo: num roteador, tudo que
 * este registro tem é o PREFIXO do id — que diz o fabricante, não o modelo.
 * `openai/gpt-4o` enxerga imagem e `openai/gpt-3.5-turbo` não, e os dois têm o
 * mesmo prefixo. Já o catálogo (`ai_models.supports_vision`) é sincronizado das
 * modalidades que a própria OpenRouter declara, então ali ele é MEDIDA e este
 * registro é PALPITE. Ver `enxergaImagem` em `lib/ai/pontos/capacidade-em-vigor.ts`.
 */
export function ehRoteador(provider: string): boolean {
  return ROTEADORES.has(provider?.toLowerCase() ?? "");
}

// Substrings de modelos que NÃO são de chat multimodal (embeddings, TTS, etc.)
// — rebaixam mesmo num provider capaz. Deny-list explícita e pequena.
const TEXT_ONLY_HINTS = ["embedding", "tts", "whisper", "moderation"];

export function modelCapabilities(provider: string, modelId: string): ModelCapabilities {
  const id = (modelId ?? "").toLowerCase();
  if (TEXT_ONLY_HINTS.some((h) => id.includes(h))) return { ...NONE };
  const p = provider?.toLowerCase();
  // Num roteador, quem responde é o fabricante do prefixo: `openai/gpt-4o` →
  // `openai`. Sem prefixo não dá para saber, e o desfecho é o mesmo de antes
  // (conservador), não um chute.
  if (ROTEADORES.has(p ?? "")) {
    const fabricante = id.includes("/") ? id.slice(0, id.indexOf("/")) : "";
    return { ...(PROVIDER_DEFAULT[fabricante] ?? NONE) };
  }
  const base = PROVIDER_DEFAULT[p] ?? NONE;
  return { ...base };
}

/**
 * Distingue "sei que não consegue" de "não sei" — a diferença que o aviso ao
 * operador precisa dizer. Um provedor/modelo que este registro não conhece cai
 * em `{false,false}` por conservadorismo, e afirmar "não enxerga imagens" nesse
 * caso é gravar uma alegação que ninguém verificou.
 */
export function capacidadeEhConhecida(provider: string, modelId: string): boolean {
  const id = (modelId ?? "").toLowerCase();
  if (TEXT_ONLY_HINTS.some((h) => id.includes(h))) return true;
  const p = provider?.toLowerCase() ?? "";
  if (ROTEADORES.has(p)) {
    const fabricante = id.includes("/") ? id.slice(0, id.indexOf("/")) : "";
    return PROVIDER_DEFAULT[fabricante] !== undefined;
  }
  return PROVIDER_DEFAULT[p] !== undefined;
}

/**
 * Este MODELO aceita áudio como ENTRADA — ou seja, consegue transcrever uma
 * nota de voz sem passar pela API de transcrição de ninguém (#2171).
 *
 * É a informação que o ponto `transcricao_de_audio` já declara em
 * `exige: { audio: true }` — "este ponto PRECISA de quem transcreva" — mas
 * até aqui nada dizia QUEM no catálogo sabe fazer isso. Sem esta pergunta, o
 * produto exigia uma segunda conta (uma chave OpenAI) de uma organização que
 * roda Gemini com a chave do Google já validada, e o áudio ficava sem ler.
 *
 * Conservador POR CONSTRUÇÃO, como o resto deste registro: só afirma áudio
 * para o que se sabe que funciona.
 *
 *  - **Google (direto)** — Gemini aceita áudio nativamente na entrada
 *    (parte `file` com mediaType `audio/*`), que é como a chamada sai aqui.
 *  - **OpenAI (direto)** — só os modelos de áudio (`*-audio-*`); os modelos de
 *    chat textuais não aceitam `input_audio`.
 *  - **Anthropic e provedores desconhecidos** — `false`: o registro não tem
 *    medida, e o degrau seguinte da escada (o padrão OpenAI-compatível) é o
 *    desfecho de sempre para quem não declara.
 *  - **Roteadores** — o prefixo decide, como em `modelCapabilities`: `google/…`
 *    vale, `openai/…` só com o id de áudio, o resto não.
 *  - `whisper`, `tts`, `embedding`, `moderation` — nunca: não são modelos de
 *    conversa (deny-list de sempre, `TEXT_ONLY_HINTS`).
 */
export function transcreveAudio(provider: string, modelId: string): boolean {
  const id = (modelId ?? "").toLowerCase();
  if (TEXT_ONLY_HINTS.some((h) => id.includes(h))) return false;
  const p = provider?.toLowerCase() ?? "";
  if (ROTEADORES.has(p)) {
    const fabricante = id.includes("/") ? id.slice(0, id.indexOf("/")) : "";
    return fabricante === "google" || (fabricante === "openai" && id.includes("audio"));
  }
  if (p === "google") return true;
  if (p === "openai") return id.includes("audio");
  return false;
}
