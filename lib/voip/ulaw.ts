/**
 * G.711 μ-law <-> PCM16 linear, implementação de referência bit-exata
 * (mesmo algoritmo usado em libsox/ffmpeg/Sun audio — tabela de bias+clip
 * padrão ITU-T G.711). Precisa disto pro caminho AudioSocket: Asterisk manda
 * áudio da chamada como PCM16 linear (SLIN, 8kHz) — a OpenAI Realtime já
 * está configurada pra audio/pcmu (μ-law), então a conversão acontece aqui,
 * não lá.
 */

const BIAS = 0x84;
const CLIP = 32635;

export function linearToUlawSample(sampleIn: number): number {
  let sample = sampleIn;
  const sign = sample < 0 ? 0x80 : 0;
  if (sign) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;

  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) {
    exponent--;
  }
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

const ULAW_DECODE_TABLE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const ulaw = ~i & 0xff;
  const sign = ulaw & 0x80;
  const exponent = (ulaw >> 4) & 0x07;
  const mantissa = ulaw & 0x0f;
  let sample = ((mantissa << 3) + BIAS) << exponent;
  sample -= BIAS;
  ULAW_DECODE_TABLE[i] = sign ? -sample : sample;
}

export function ulawToLinearSample(ulawByte: number): number {
  // ulawByte é sempre 0-255 na prática (byte de um Buffer) — o "?? 0" é só
  // pra satisfazer noUncheckedIndexedAccess, nunca deveria disparar de fato.
  return ULAW_DECODE_TABLE[ulawByte] ?? 0;
}

/** PCM16 little-endian -> μ-law (1 byte por amostra). */
export function pcm16ToUlaw(pcm: Buffer): Buffer {
  const out = Buffer.alloc(pcm.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = linearToUlawSample(pcm.readInt16LE(i * 2));
  }
  return out;
}

/** μ-law -> PCM16 little-endian (2 bytes por amostra). */
export function ulawToPcm16(ulaw: Buffer): Buffer {
  const out = Buffer.alloc(ulaw.length * 2);
  for (let i = 0; i < ulaw.length; i++) {
    out.writeInt16LE(ulawToLinearSample(ulaw[i] ?? 0), i * 2);
  }
  return out;
}
