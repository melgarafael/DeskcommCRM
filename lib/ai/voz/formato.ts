/**
 * O FORMATO DA NOTA DE VOZ DO AGENTE — decidido pelo canal, não pelo gosto.
 *
 * O canal que CONVERTE áudio (`voiceNote: "server-convert"`, o pareado) recebe
 * mp3 e o entrega como nota de voz. O canal oficial e o seu intermediário
 * (`"opus-only"`) não convertem: aceitam a flag de nota de voz, mas exigem
 * `audio/ogg` com codec opus, mono — mp3 com a flag chega como anexo de música
 * (`lib/channels/capabilities.ts`).
 *
 * Até aqui o agente simplesmente NÃO FALAVA nesses canais (`voz-do-turno.ts`
 * devolvia `null`), porque o worker não tem ffmpeg para converter. Não precisa:
 * a própria ElevenLabs sintetiza em opus. Medido em 02/11/2026 contra a API
 * real (uma frase de 38 caracteres, `output_format=opus_48000_32`): 200,
 * `content-type: audio/opus`, os 4 primeiros bytes `OggS` (contêiner OGG), a
 * página de cabeçalho `OpusHead` e 1 canal — exatamente o que a nota de voz pede.
 *
 * ⚠️ A etiqueta é `audio/ogg;codecs=opus`, e NÃO o `audio/opus` que a ElevenLabs
 * devolve: o canal oficial lista `audio/ogg (OPUS codecs only; base audio/ogg
 * not supported)`, e o Content-Type que o Storage serve é o que gravamos. A
 * constante é a MESMA da conversão de gravações do composer (`VOICE_MIME`), que
 * já pagou esse erro uma vez com o 131053.
 */
import { VOICE_MIME } from "@/lib/messaging/media/voice-transcode";

export type FormatoDaVoz = "mp3" | "ogg_opus";

/** O `output_format` da ElevenLabs para a nota de voz em opus — 32 kbps basta para fala. */
export const SAIDA_OPUS_DA_ELEVENLABS = "opus_48000_32";

/** O Content-Type com que a nota de voz em opus é guardada e servida ao canal. */
export const MIME_DA_NOTA_DE_VOZ_OPUS = VOICE_MIME;

/** O formato que o canal da conversa entrega como nota de voz. */
export function formatoDaVozParaCanal(voiceNote: "server-convert" | "opus-only"): FormatoDaVoz {
  return voiceNote === "opus-only" ? "ogg_opus" : "mp3";
}

/** A extensão do arquivo guardado — e a única coisa que diz o formato num retry. */
export function extensaoDoFormato(formato: FormatoDaVoz): "ogg" | "mp3" {
  return formato === "ogg_opus" ? "ogg" : "mp3";
}

/**
 * O Content-Type de uma nota de voz JÁ guardada, lido do caminho.
 *
 * O retry de um envio reaproveita o áudio sintetizado na tentativa anterior
 * (`resolverCaminhoDeVoz`) e não tem a resposta da síntese na mão: o que ele tem
 * é o caminho. Era `audio/mpeg` fixo — certo enquanto só existia mp3.
 */
export function mimeDoCaminhoDeVoz(caminho: string): string {
  return caminho.toLowerCase().endsWith(".ogg") ? MIME_DA_NOTA_DE_VOZ_OPUS : "audio/mpeg";
}

/** Os 4 primeiros bytes de todo arquivo OGG. */
export function ehContainerOgg(audio: Buffer): boolean {
  return audio.length >= 4 && audio.subarray(0, 4).toString("latin1") === "OggS";
}
