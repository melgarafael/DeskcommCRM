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
 * No webm do Chrome o codec já é opus dos dois lados e o que muda é o
 * CONTAINER: `-c:a copy`, sem reencodar, sem perda, e rápido o bastante para
 * caber no caminho do upload. A nota de voz do iPhone (`audio/mp4`, AAC) não
 * é opus: ela é REENCODADA em opus (`libopus`), que custa CPU — por isso só
 * entra quando o gravador do composer a marca como nota de voz.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
export const VOICE_MIME = "audio/ogg;codecs=opus";

/** Teto de segurança: nota de voz é curta, e acima disto é outra coisa. */
const MAX_BYTES = 16 * 1024 * 1024;

/**
 * Teto da conversão para TOCAR (F2): é CPU da VPS a cada toque, e 5MB de opus
 * já são ~25 min de voz. Acima disso o aparelho mostra "indisponível" com a
 * transcrição, em vez de travar o servidor.
 */
export const TETO_REPRODUCAO_BYTES = 5 * 1024 * 1024;

/**
 * Quantas conversões para TOCAR rodam ao mesmo tempo neste processo. O teto
 * por minuto da rota não basta: 120 por organização com 30s de prazo cada
 * cabem dezenas de ffmpeg juntos, disputando a CPU com o próprio Next.
 */
export const CONVERSOES_SIMULTANEAS = 2;
let conversoesEmCurso = 0;

/**
 * E no máximo esta quantidade por ORGANIZAÇÃO, dentro do teto acima: numa
 * instalação com várias empresas, uma só não ocupa as duas vagas e deixa as
 * outras sem tocar áudio enquanto converte.
 */
export const CONVERSOES_POR_ORGANIZACAO = 1;
const emCursoPorOrganizacao = new Map<string, number>();

/** Conversor cheio: é espera, não defeito. A rota responde 503 com `Retry-After`. */
export class ConversorOcupado extends Error {
  constructor() {
    super("conversor_ocupado");
    this.name = "ConversorOcupado";
  }
}

/** Prazo de qualquer ffmpeg daqui: sem ele, um arquivo patológico prende o processo. */
const PRAZO_FFMPEG_MS = 30_000;

function baseDoMime(mime: string): string {
  return mime.split(";")[0]?.trim().toLowerCase() ?? "";
}

function ehWebm(base: string): boolean {
  return base === "audio/webm" || base === "video/webm";
}

/**
 * Precisa converter?
 *
 * Sempre: `webm` com opus (o Chrome) — o resto ou já serve, ou não é nosso
 * problema resolver aqui.
 *
 * Com `notaDeVoz` (o gravador do composer marcou): TODO áudio que não é ogg. O
 * iPhone grava `audio/mp4` (AAC), e os canais oficiais só aceitam opus como
 * nota de voz. A regra é "não é ogg", e não uma lista de mimes do Safari,
 * porque o mime que cada versão do iOS anuncia muda. Sem a marca, um m4a
 * enviado por token segue intacto: uma música não pode virar opus mono de 24k.
 */
export function precisaTranscodificar(mime: string, notaDeVoz = false): boolean {
  const base = baseDoMime(mime);
  if (ehWebm(base)) return true;
  if (!notaDeVoz) return false;
  const ehAudio = base.startsWith("audio/") || base.startsWith("video/");
  return ehAudio && base !== "audio/ogg" && base !== "audio/opus";
}

export interface Transcodificacao {
  buffer: Buffer;
  mime: string;
  /** `false` = devolvido intacto, porque não precisava (ou não deu). */
  convertido: boolean;
}

/**
 * Só os contêineres de áudio que este módulo recebe, lidos só do arquivo local:
 * o ffmpeg não adivinha o formato de entrada por conta própria. Vai ANTES do
 * `-i`, em toda chamada daqui.
 */
export const ENTRADA_ACEITA = [
  "-protocol_whitelist", "file",
  "-format_whitelist", "ogg,matroska,webm,mov,mp4,m4a,3gp,3g2,mj2",
] as const;

/** Roda ffmpeg; rejeita se sair diferente de zero. Injetável para teste. */
async function runFfmpeg(args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn("ffmpeg", ["-nostdin", "-y", ...args], { cwd });
    const prazo = setTimeout(() => proc.kill("SIGKILL"), PRAZO_FFMPEG_MS);
    proc.on("close", () => clearTimeout(prazo));
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
 * Nota de voz → Ogg/Opus: o webm só troca de container; o resto marcado como
 * nota de voz (o AAC do iPhone) é reencodado em opus.
 *
 * Falha devolve o original INTACTO, não erro: um áudio que talvez não saia é
 * melhor que um envio que morre antes de tentar — e o canal que aceita webm
 * (porque converte sozinho) continua funcionando como sempre.
 */
export async function transcodificarNotaDeVoz(
  input: { buffer: Buffer; mime: string; notaDeVoz?: boolean },
  deps: { run?: typeof runFfmpeg } = {},
): Promise<Transcodificacao> {
  if (!precisaTranscodificar(input.mime, input.notaDeVoz)) {
    return { buffer: input.buffer, mime: input.mime, convertido: false };
  }
  if (input.buffer.length > MAX_BYTES) {
    return { buffer: input.buffer, mime: input.mime, convertido: false };
  }

  const executar = deps.run ?? runFfmpeg;
  const dir = await mkdtemp(join(tmpdir(), "voz-"));
  try {
    const entrada = join(dir, "in.audio");
    const saida = join(dir, "out.ogg");
    await writeFile(entrada, input.buffer);
    // webm: `-c:a copy` — o codec já é opus dos dois lados, reencodar custaria
    // tempo e qualidade para chegar ao mesmo lugar. O resto (o AAC do iPhone)
    // não é opus: copiar o container não serve, tem de reencodar.
    const codec = ehWebm(baseDoMime(input.mime))
      ? ["-c:a", "copy"]
      : ["-c:a", "libopus", "-b:a", "24k", "-ac", "1", "-ar", "48000"];
    await executar([...ENTRADA_ACEITA, "-i", entrada, "-vn", ...codec, "-f", "ogg", saida], dir);
    const buffer = await readFile(saida);
    if (buffer.length === 0) return { buffer: input.buffer, mime: input.mime, convertido: false };
    return { buffer, mime: VOICE_MIME, convertido: true };
  } catch {
    return { buffer: input.buffer, mime: input.mime, convertido: false };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Áudio que o aparelho não toca (ogg/opus no Safari do iPhone antes do 18.4)
 * → AAC em MP4, que todo navegador toca. F2 da ADR-0006.
 *
 * NADA é guardado: os bytes saem daqui direto para a resposta (`no-store`) e o
 * aparelho toca em memória. Guardar a cópia no Storage criaria um arquivo
 * derivado que o expurgo de mídia e a anonimização não alcançam.
 *
 * Ao contrário da nota de voz, falha REJEITA: devolver o ogg que o aparelho
 * não toca seria responder 200 com um arquivo mudo. Quem chama responde 502.
 *
 * ponytail: converte a cada toque (CPU da VPS, com teto de 30/min por pessoa
 * na rota, `CONVERSOES_SIMULTANEAS` por processo e `CONVERSOES_POR_ORGANIZACAO`
 * dentro dele — contadores em memória, que
 * vale por réplica do app). Se o custo pesar, guardar a cópia no Storage — mas
 * só com o expurgo e a anonimização cobrindo a cópia, provados por teste.
 */
export async function paraReproducaoAac(
  buffer: Buffer,
  organizationId: string,
  deps: { run?: typeof runFfmpeg } = {},
): Promise<Buffer> {
  if (buffer.length > TETO_REPRODUCAO_BYTES) throw new Error("audio_grande_demais");
  const daOrganizacao = emCursoPorOrganizacao.get(organizationId) ?? 0;
  if (conversoesEmCurso >= CONVERSOES_SIMULTANEAS || daOrganizacao >= CONVERSOES_POR_ORGANIZACAO) {
    throw new ConversorOcupado();
  }
  const executar = deps.run ?? runFfmpeg;
  conversoesEmCurso++;
  emCursoPorOrganizacao.set(organizationId, daOrganizacao + 1);
  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(tmpdir(), "tocar-"));
    const entrada = join(dir, "in.audio");
    const saida = join(dir, "out.m4a");
    await writeFile(entrada, buffer);
    await executar(
      [...ENTRADA_ACEITA, "-i", entrada, "-vn", "-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart", "-f", "mp4", saida],
      dir,
    );
    const convertido = await readFile(saida);
    if (convertido.length === 0) throw new Error("ffmpeg_saida_vazia");
    return convertido;
  } finally {
    conversoesEmCurso--;
    const restantes = (emCursoPorOrganizacao.get(organizationId) ?? 1) - 1;
    if (restantes > 0) emCursoPorOrganizacao.set(organizationId, restantes);
    else emCursoPorOrganizacao.delete(organizationId);
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
