/**
 * Normalização e otimização de vídeos para WhatsApp.
 *
 * ─── O defeito, medido em produção ──────────────────────────────────────────
 *
 * Smartphones modernos (especialmente iPhone com iOS 11+ e Androids recentes)
 * gravam vídeos no formato HEVC (H.265) ou QuickTime (.mov), e colocam o átomo
 * de metadados (`moov atom`) no FINAL do arquivo.
 *
 * O WhatsApp Web e a engine do WhatsApp RECUSAM vídeos que:
 *  1. Não usem o codec H.264 (AVC) e áudio AAC;
 *  2. Não tenham o `moov atom` no início (+faststart para streaming imediato);
 *  3. Venham em containers não-MP4 (ex: .mov, .webm, .mkv, .avi).
 *
 * ─── A Solução ──────────────────────────────────────────────────────────────
 *
 * Executa uma normalização rápida com FFmpeg no servidor (preset ultrafast):
 *  - Se for MP4 com H.264, apenas remuxa com `-movflags +faststart` (em < 1s).
 *  - Se for HEVC/QuickTime/outros, transcodifica para H.264 + AAC + faststart.
 *  - Se o FFmpeg não estiver disponível ou falhar, devolve o buffer original
 *    intacto (fallback seguro que nunca impede o upload).
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TranscodificacaoVideo {
  buffer: Buffer;
  mime: string;
  convertido: boolean;
}

/** Teto de tamanho para tentar transcodificação de vídeo: 150MB */
const MAX_VIDEO_TRANSCODE_BYTES = 150 * 1024 * 1024;

/** Roda ffmpeg; rejeita se sair diferente de zero. */
async function runFfmpeg(args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn("ffmpeg", ["-nostdin", "-y", ...args], { cwd });
    let erro = "";
    proc.stderr?.on("data", (d: Buffer) => {
      erro = (erro + d.toString()).slice(-500);
    });
    proc.on("error", (err) => reject(new Error(`ffmpeg_spawn_failed: ${err.message}`)));
    proc.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg_exit_${code}: ${erro}`)),
    );
  });
}

/**
 * Normaliza um vídeo para MP4 (H.264 + AAC + faststart) compatível com o WhatsApp.
 * Devolve o buffer convertido ou o original em caso de falha/indisponibilidade.
 */
export async function normalizarVideoParaWhatsApp(
  input: { buffer: Buffer; mime: string },
  deps: { run?: typeof runFfmpeg } = {},
): Promise<TranscodificacaoVideo> {
  // Se for maior que 150MB, não tenta transcodificar no servidor para economizar CPU/tempo
  if (input.buffer.length > MAX_VIDEO_TRANSCODE_BYTES || input.buffer.length === 0) {
    return { buffer: input.buffer, mime: input.mime, convertido: false };
  }

  const executar = deps.run ?? runFfmpeg;
  const dir = await mkdtemp(join(tmpdir(), "video-norm-"));

  try {
    const entrada = join(dir, "in_media");
    const saida = join(dir, "out_media.mp4");
    await writeFile(entrada, input.buffer);

    // Converte para H.264 + AAC + faststart com preset ultrafast para ser quase instantâneo
    await executar(
      [
        "-i",
        entrada,
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "26",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-movflags",
        "+faststart",
        saida,
      ],
      dir,
    );

    const bufferConvertido = await readFile(saida);
    if (bufferConvertido.length === 0) {
      return { buffer: input.buffer, mime: input.mime, convertido: false };
    }

    return {
      buffer: bufferConvertido,
      mime: "video/mp4",
      convertido: true,
    };
  } catch {
    // Fallback gracioso: se o FFmpeg não rodar ou falhar, mantém o arquivo original intacto
    return { buffer: input.buffer, mime: input.mime, convertido: false };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
