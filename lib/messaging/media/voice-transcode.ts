/**
 * Nota de voz gravada no browser → o formato que o WhatsApp aceita.
 *
 * ─── O defeito, medido em produção ──────────────────────────────────────────
 *
 * O `MediaRecorder` do Chrome não sabe gravar `audio/ogg`. Ele aceita o pedido,
 * cai no fallback `audio/webm;codecs=opus`, e o áudio sai do CRM nesse
 * container. O canal oficial recusa depois de aceitar o envio:
 *
 *   131053 — Media upload error — WhatsApp could not download the media
 *   attachment. Make sure the media URL is publicly accessible and in a
 *   supported format.
 *
 * A mensagem culpa a URL, e a URL estava certa: `webm` simplesmente não está na
 * lista de formatos de áudio aceitos (MP3, OGG, AMR, AAC). O operador vê
 * "falhou" numa nota de voz que gravou normalmente, sem nada dizendo o motivo
 * real.
 *
 * ─── Por que converter no UPLOAD, e não no envio ────────────────────────────
 *
 * Convertendo uma vez, ao guardar, TODO canal recebe um arquivo válido — e o
 * mesmo áudio pode ser reenviado, encaminhado ou usado por outro canal depois
 * sem repetir o trabalho. Converter no envio faria a mesma gravação ser
 * transcodificada a cada destinatário, e deixaria o arquivo guardado num
 * formato que só um canal aceita.
 *
 * ─── Por que não simplesmente mandar sem `voiceNote` ────────────────────────
 *
 * Porque não resolve: `webm` não é aceito nem como anexo comum. E porque a nota
 * de voz É o formato — chegar como arquivo anexo, sem a bolha e sem a onda,
 * muda o que a pessoa recebe.
 *
 * O codec já é opus dos dois lados; o que muda é o CONTAINER. Por isso
 * `-c:a copy`: sem reencodar, sem perda, e rápido o bastante para caber no
 * caminho do upload.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MAX_VOICE_BYTES, VOICE_MIME } from "@/lib/messaging/media/voice-constants";

export { MAX_VOICE_BYTES, VOICE_MIME } from "@/lib/messaging/media/voice-constants";

/**
 * O que o WhatsApp aceita como nota de voz.
 *
 * O `codecs=opus` NÃO é enfeite: a doc do canal oficial lista
 * `audio/ogg (OPUS codecs only; base audio/ogg not supported)`. Guardar o
 * arquivo como `audio/ogg` puro faz o Storage servir esse Content-Type, e a
 * plataforma recusa o download com o MESMO `131053` que o cabeçalho deste
 * arquivo descreve — a conversão acertava o container e errava a etiqueta.
 *
 * O defeito só aparecia no Chrome, e é por isso que passou: o Firefox grava
 * direto em `audio/ogg;codecs=opus` (`AudioRecorder.tsx`, `PREFERRED_MIMES`),
 * não passa por aqui, e a nota de voz dele sempre chegou. Esta é literalmente a
 * mesma string que o browser usa quando sabe gravar ogg.
 */
/**
 * Precisa converter? Só `webm` com opus — o resto ou já serve, ou não é nosso
 * problema resolver aqui.
 */
export function precisaTranscodificar(mime: string): boolean {
  const base = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  return base === "audio/webm" || base === "video/webm";
}

export interface Transcodificacao {
  buffer: Buffer;
  mime: string;
  /** `false` = devolvido intacto, porque não precisava (ou não deu). */
  convertido: boolean;
}

/** Roda ffmpeg; rejeita se sair diferente de zero. Injetável para teste. */
async function runFfmpeg(args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn("ffmpeg", ["-nostdin", "-y", ...args], { cwd });
    let erro = "";
    proc.stderr?.on("data", (d: Buffer) => {
      // Só o fim interessa: ffmpeg escreve muito e o erro vem por último.
      erro = (erro + d.toString()).slice(-500);
    });
    proc.on("error", (err) => reject(new Error(`ffmpeg_spawn_failed: ${err.message}`)));
    proc.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg_exit_${code}: ${erro}`)),
    );
  });
}

/**
 * WebM/Opus → Ogg/Opus, trocando só o container.
 *
 * Falha devolve o original INTACTO, não erro: um áudio que talvez não saia é
 * melhor que um envio que morre antes de tentar — e o canal que aceita webm
 * (porque converte sozinho) continua funcionando como sempre.
 */
export async function transcodificarNotaDeVoz(
  input: { buffer: Buffer; mime: string },
  deps: { run?: typeof runFfmpeg } = {},
): Promise<Transcodificacao> {
  if (!precisaTranscodificar(input.mime)) {
    return { buffer: input.buffer, mime: input.mime, convertido: false };
  }
  if (input.buffer.length > MAX_VOICE_BYTES) {
    return { buffer: input.buffer, mime: input.mime, convertido: false };
  }

  const executar = deps.run ?? runFfmpeg;
  const dir = await mkdtemp(join(tmpdir(), "voz-"));
  try {
    const entrada = join(dir, "in.webm");
    const saida = join(dir, "out.ogg");
    await writeFile(entrada, input.buffer);
    // `-c:a copy`: o codec já é opus dos dois lados. Reencodar custaria tempo e
    // qualidade para chegar ao mesmo lugar.
    await executar(["-i", entrada, "-vn", "-c:a", "copy", "-f", "ogg", saida], dir);
    const buffer = await readFile(saida);
    if (buffer.length === 0) return { buffer: input.buffer, mime: input.mime, convertido: false };
    return { buffer, mime: VOICE_MIME, convertido: true };
  } catch {
    return { buffer: input.buffer, mime: input.mime, convertido: false };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
