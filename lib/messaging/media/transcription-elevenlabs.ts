/**
 * Transcrição via ElevenLabs Scribe — a segunda opção do menu de
 * `transcricao_de_audio` (ver `lib/ai/pontos/registro.ts`). Implementa a MESMA
 * `TranscriptionProvider` de `transcription.ts`, mas é um arquivo PRÓPRIO, não
 * um `baseUrl` alternativo daquele: o Scribe não é OpenAI-compatível — o header
 * de auth é `xi-api-key` (não `Authorization: Bearer`), o endpoint é
 * `/v1/speech-to-text`, e o campo do modelo no multipart é `model_id`, não
 * `model`. Tratar como "mesmo formato, endpoint diferente" seria a mesma
 * mentira que a credencial de serviço existe para evitar.
 */
import { extFor, type TranscriptionProvider } from "./transcription";

export interface ElevenLabsTranscriptionCreds {
  apiKey: string;
  /** Default `scribe_v1` — o mesmo id que `registro.ts` declara no menu. */
  model?: string;
}

const BASE = "https://api.elevenlabs.io";
const DEFAULT_MODEL = "scribe_v1";

export function elevenLabsTranscriptionProvider(
  creds: ElevenLabsTranscriptionCreds,
  fetchImpl: typeof fetch = fetch,
): TranscriptionProvider {
  const model = creds.model ?? DEFAULT_MODEL;
  return {
    async transcribe(audio, mime) {
      const form = new FormData();
      form.append("model_id", model);
      form.append(
        "file",
        new Blob([new Uint8Array(audio)], { type: mime.split(";")[0]!.trim() }),
        `audio.${extFor(mime)}`,
      );
      const res = await fetchImpl(`${BASE}/v1/speech-to-text`, {
        method: "POST",
        headers: { "xi-api-key": creds.apiKey },
        body: form,
      });
      if (!res.ok) throw new Error(`transcription_${res.status}`);
      // O Scribe devolve diarização (`words[].speaker_id`) junto do texto. O
      // MVP descarta: o derivado alimenta o prompt do agente, e falante
      // rotulado ali é token gasto sem o agente ter o que fazer com ele — a
      // decisão está escrita no plano (docs/superpowers/plans/2026-10-29-
      // voz-elevenlabs.md §3). Se um dia isso mudar, é aqui que se lê `words`.
      const json = (await res.json()) as { text?: string };
      return json.text ?? "";
    },
  };
}
