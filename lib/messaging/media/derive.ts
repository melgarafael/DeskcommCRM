/**
 * Derivação textual de mídia (Onda 3, camada UNIVERSAL). Puro: as capacidades
 * (transcrição, visão, extração de pdf) são injetadas — o worker as monta com as
 * credenciais BYOK da org. O resultado é texto que qualquer modelo de chat lê.
 */
import type { TranscriptionProvider } from "@/lib/messaging/media/transcription";

const MAX_DERIVED_CHARS = 8000;

export interface DeriveDeps {
  transcriber: TranscriptionProvider;
  describeImage(buffer: Buffer, mime: string): Promise<string>;
  extractPdf(buffer: Buffer): Promise<string>;
  /** Onda 3.1: derivação de vídeo (ffmpeg → áudio+frames). Ausente = vídeo não derivado. */
  deriveVideo?: (buffer: Buffer, mime: string) => Promise<string>;
}

export async function deriveMediaText(
  kind: string,
  buffer: Buffer,
  mime: string,
  deps: DeriveDeps,
): Promise<string> {
  const base = mime.split(";")[0]!.trim().toLowerCase();
  let text = "";
  if (kind === "audio") {
    text = await deps.transcriber.transcribe(buffer, mime);
  } else if (kind === "document" && base === "application/pdf") {
    text = await deps.extractPdf(buffer);
  } else if (kind === "image") {
    text = await deps.describeImage(buffer, mime);
  } else if (kind === "video" && deps.deriveVideo) {
    text = await deps.deriveVideo(buffer, mime);
  }
  // sticker/document-não-pdf (e vídeo sem deriveVideo): sem derivado.
  return (text ?? "").slice(0, MAX_DERIVED_CHARS);
}
