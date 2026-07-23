/**
 * Derivação de VÍDEO (Onda 3.1). ffmpeg extrai a faixa de áudio (→ transcrição)
 * e N frames (→ descrição por visão); o derivado combina os dois em texto que
 * qualquer modelo lê (camada universal). Atrás da flag por-agente
 * `video_frames_enabled` (custo: 1 transcrição + N chamadas de visão por vídeo).
 *
 * ffmpeg roda via child_process num diretório temporário isolado (limpo sempre,
 * inclusive em erro). As chamadas de ffmpeg são injetáveis (`runFfmpeg`) p/ teste.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TranscriptionProvider } from "@/lib/messaging/media/transcription";

/** Nº de frames amostrados do vídeo (distribuídos ao longo da duração). */
const FRAME_COUNT = 4;
/** Teto de segurança p/ o vídeo processado (evita ffmpeg travar em arquivo gigante). */
const FRAME_SCALE = "512:-1";

export interface VideoDeriveDeps {
  transcriber: TranscriptionProvider;
  describeImage(buffer: Buffer, mime: string): Promise<string>;
  /** Executa ffmpeg com os args dados no cwd; rejeita em exit != 0. Injetável p/ teste. */
  runFfmpeg?: (args: string[], cwd: string) => Promise<void>;
}

function defaultRunFfmpeg(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", ["-nostdin", "-y", ...args], { cwd });
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += String(d);
    });
    proc.on("error", (err) => reject(new Error(`ffmpeg_spawn_failed: ${err.message}`)));
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg_exit_${code}: ${stderr.slice(-200)}`));
    });
  });
}

/**
 * Deriva texto de um vídeo: transcrição do áudio + descrições de frames.
 * Best-effort por trilha: se o vídeo não tem áudio, a transcrição é vazia e
 * seguimos só com os frames (e vice-versa). Sempre limpa os arquivos temporários.
 */
export async function deriveVideoText(buffer: Buffer, deps: VideoDeriveDeps): Promise<string> {
  const run = deps.runFfmpeg ?? defaultRunFfmpeg;
  const dir = await mkdtemp(join(tmpdir(), "vid-derive-"));
  try {
    await writeFile(join(dir, "in.mp4"), buffer);

    // 1) faixa de áudio → ogg/opus mono 16k (ideal p/ Whisper). Pode falhar se sem áudio.
    let transcript = "";
    try {
      await run(["-i", "in.mp4", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libopus", "audio.ogg"], dir);
      const audio = await readFile(join(dir, "audio.ogg"));
      if (audio.byteLength > 0) transcript = await deps.transcriber.transcribe(audio, "audio/ogg");
    } catch {
      transcript = "";
    }

    // 2) N frames distribuídos ao longo do vídeo → jpg.
    let frameDescriptions: string[] = [];
    try {
      await run(
        ["-i", "in.mp4", "-vf", `thumbnail,scale=${FRAME_SCALE}`, "-frames:v", String(FRAME_COUNT), "frame-%02d.jpg"],
        dir,
      );
      const files = (await readdir(dir)).filter((f) => f.startsWith("frame-")).sort();
      const described = await Promise.all(
        files.map(async (f) => {
          const bytes = await readFile(join(dir, f));
          try {
            return await deps.describeImage(bytes, "image/jpeg");
          } catch {
            return "";
          }
        }),
      );
      frameDescriptions = described.filter((d) => d.trim() !== "");
    } catch {
      frameDescriptions = [];
    }

    const parts: string[] = [];
    if (transcript.trim() !== "") parts.push(`Transcrição do áudio do vídeo: ${transcript.trim()}`);
    if (frameDescriptions.length > 0)
      parts.push(`Cenas do vídeo:\n${frameDescriptions.map((d, i) => `- Quadro ${i + 1}: ${d.trim()}`).join("\n")}`);
    return parts.join("\n\n");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
