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

// Substrings de modelos que NÃO são de chat multimodal (embeddings, TTS, etc.)
// — rebaixam mesmo num provider capaz. Deny-list explícita e pequena.
const TEXT_ONLY_HINTS = ["embedding", "tts", "whisper", "moderation"];

export function modelCapabilities(provider: string, modelId: string): ModelCapabilities {
  const id = (modelId ?? "").toLowerCase();
  if (TEXT_ONLY_HINTS.some((h) => id.includes(h))) return { ...NONE };
  const base = PROVIDER_DEFAULT[provider?.toLowerCase()] ?? NONE;
  return { ...base };
}
