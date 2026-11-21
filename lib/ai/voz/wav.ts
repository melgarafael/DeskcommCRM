/**
 * PCM cru → arquivo WAV, sem ffmpeg.
 *
 * A ElevenLabs sintetiza em PCM (`pcm_24000`: amostras de 16 bits, little-endian,
 * mono, 24 kHz), sem cabeçalho nenhum. As DMs do Instagram aceitam WAV e recusam
 * mp3 e ogg/opus — e o worker não tem ffmpeg. Não precisa: um WAV PCM é o PCM
 * com 44 bytes de cabeçalho RIFF na frente. O formato é o "canonical WAVE" da
 * Microsoft (RIFF / fmt  / data), lido por qualquer tocador.
 */

/** O `output_format` da ElevenLabs que vira WAV — 24 kHz, 16 bits, mono. */
export const SAIDA_PCM_DA_ELEVENLABS = "pcm_24000";
export const TAXA_DO_PCM_DA_ELEVENLABS = 24_000;

export const MIME_DO_WAV = "audio/wav";

const BYTES_DO_CABECALHO = 44;
const BITS_POR_AMOSTRA = 16;
const CANAIS = 1;

/**
 * Embrulha amostras PCM de 16 bits mono num WAV.
 *
 * Um número ímpar de bytes não é PCM de 16 bits: é resposta truncada ou outro
 * formato. Lança em vez de embrulhar — quem chama cai para texto.
 */
export function embrulharPcmEmWav(pcm: Buffer, taxa: number = TAXA_DO_PCM_DA_ELEVENLABS): Buffer {
  if (pcm.length === 0 || pcm.length % 2 !== 0) throw new Error("synthesis_formato_inesperado");
  const bytesPorBloco = (CANAIS * BITS_POR_AMOSTRA) / 8;
  const cabecalho = Buffer.alloc(BYTES_DO_CABECALHO);
  cabecalho.write("RIFF", 0, "latin1");
  cabecalho.writeUInt32LE(BYTES_DO_CABECALHO - 8 + pcm.length, 4);
  cabecalho.write("WAVE", 8, "latin1");
  cabecalho.write("fmt ", 12, "latin1");
  cabecalho.writeUInt32LE(16, 16); // tamanho do bloco fmt para PCM
  cabecalho.writeUInt16LE(1, 20); // 1 = PCM sem compressão
  cabecalho.writeUInt16LE(CANAIS, 22);
  cabecalho.writeUInt32LE(taxa, 24);
  cabecalho.writeUInt32LE(taxa * bytesPorBloco, 28); // bytes por segundo
  cabecalho.writeUInt16LE(bytesPorBloco, 32);
  cabecalho.writeUInt16LE(BITS_POR_AMOSTRA, 34);
  cabecalho.write("data", 36, "latin1");
  cabecalho.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([cabecalho, pcm]);
}

/** Os bytes que todo WAV traz: `RIFF` no início e `WAVE` no 8º byte. */
export function ehContainerWav(audio: Buffer): boolean {
  return (
    audio.length >= 12 &&
    audio.subarray(0, 4).toString("latin1") === "RIFF" &&
    audio.subarray(8, 12).toString("latin1") === "WAVE"
  );
}
