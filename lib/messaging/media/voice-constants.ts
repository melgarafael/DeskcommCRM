/** O que o WhatsApp aceita como nota de voz. */
export const VOICE_MIME = "audio/ogg;codecs=opus";

/** Teto de segurança: nota de voz é curta, e acima disto é outra coisa. */
export const MAX_VOICE_BYTES = 16 * 1024 * 1024;
