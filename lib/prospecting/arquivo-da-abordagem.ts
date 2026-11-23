/**
 * O ARQUIVO DA PRIMEIRA ABORDAGEM QUE A PESSOA ENVIA PELA TELA (#4751).
 *
 * A mídia da campanha existe desde a #4581, mas só entrava no bucket por fora do
 * produto: a tela oferecia apenas as imagens das respostas rápidas. Vídeo e PDF
 * ficavam na mão de quem chamasse a API. Este módulo é o lado PURO do caminho que
 * fecha isso — farejar os bytes, decidir o caminho no bucket e descrever o
 * arquivo como a configuração da campanha guarda.
 *
 * ── O tipo é dos BYTES, nunca do `content-type` ─────────────────────────────
 *
 * `file.type` é o que QUEM SOBE declarou na parte multipart (o cabeçalho que o
 * mantenedor de `lib/branding/logo-arquivo.ts` já recusa como fonte de decisão).
 * O arquivo vai ser servido ao WhatsApp de outra pessoa, então o que decide é a
 * assinatura: `%PDF-`, `\xFF\xD8\xFF`, o PNG, `RIFF…WEBP` e a caixa `ftyp` do
 * MP4/3GP/MOV. `file.type` só aparece no `details` da recusa, para o log mostrar
 * a mentira.
 *
 * ── A régua de tipo e tamanho é UMA SÓ ─────────────────────────────────────
 *
 * Este módulo NÃO tem mapa de mime próprio: depois de farejar, ele chama
 * `classificarMidiaDaAbordagem` — a função do schema e do worker. É isso que
 * garante que o que a tela aceita é exatamente o que o envio aceita; uma segunda
 * allowlist aqui seria a próxima divergência.
 *
 * ── O caminho é `{org}/prospecting/<uuid>.<ext>` ───────────────────────────
 *
 * No bucket `whatsapp-media`, o MESMO que `prepararMidiaDaAbordagem` assina para
 * o worker (`BUCKET_DA_MIDIA_DA_CAMPANHA`). O prefixo `{org}/` é o que
 * `isMediaPathInOrganization` exige em `validateConfig`, e a pasta
 * `prospecting/` mantém o arquivo da campanha fora das pastas de conversa — uma
 * campanha não pertence a conversa nenhuma. O uuid e a extensão são gerados
 * AQUI, nunca aceitos do cliente.
 */
import {
  classificarMidiaDaAbordagem,
  type MidiaDaAbordagem,
} from "./midia-da-abordagem";

/** O que a tela e a rota dizem quando o arquivo não serve. Uma frase por motivo. */
export const MOTIVO_DO_TIPO_DO_ARQUIVO =
  "O arquivo precisa ser uma imagem (JPG, PNG ou WEBP), um vídeo (MP4, 3GP ou MOV) ou um PDF.";
export const MOTIVO_DO_TAMANHO_DO_ARQUIVO =
  "O arquivo passa do tamanho máximo aceito para este tipo: imagem até 5 MB, vídeo até 16 MB ou PDF até 50 MB.";

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const JPEG = [0xff, 0xd8, 0xff] as const;
/** `%PDF-` — o cabeçalho de todo PDF (ISO 32000-1 §7.5.2). */
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d] as const;
const RIFF = [0x52, 0x49, 0x46, 0x46] as const;
const WEBP = [0x57, 0x45, 0x42, 0x50] as const;

/**
 * As marcas da caixa `ftyp` — o que separa MP4 de 3GP de MOV dentro do mesmo
 * container ISO-BMFF. Lista FECHADA: marca desconhecida é recusa, não "deve ser
 * MP4". São os formatos que o WhatsApp entrega como vídeo.
 */
const MARCAS_DE_VIDEO: Record<string, string> = {
  isom: "video/mp4",
  iso2: "video/mp4",
  mp41: "video/mp4",
  mp42: "video/mp4",
  avc1: "video/mp4",
  dash: "video/mp4",
  mmp4: "video/mp4",
  MSNV: "video/mp4",
  "M4V ": "video/mp4",
  "3gp4": "video/3gpp",
  "3gp5": "video/3gpp",
  "3gp6": "video/3gpp",
  "3ge6": "video/3gpp",
  "3gg6": "video/3gpp",
  "3gs7": "video/3gpp",
  "qt  ": "video/quicktime",
};

/** A extensão que o caminho grava — fechada, como o farejador. */
const EXTENSAO_DE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "video/quicktime": "mov",
  "application/pdf": "pdf",
};

function comecaCom(bytes: Uint8Array, assinatura: readonly number[]): boolean {
  if (bytes.length < assinatura.length) return false;
  return assinatura.every((b, i) => bytes[i] === b);
}

function ascii(bytes: Uint8Array, inicio: number, fim: number): string {
  if (bytes.length < fim) return "";
  return String.fromCharCode(...bytes.subarray(inicio, fim));
}

/**
 * O mime do arquivo pelos BYTES; `null` quando não é um dos tipos da abordagem.
 *
 * `image/webp` é `RIFF` + tamanho + `WEBP`: os quatro bytes em 8..11 é o que
 * distingue o WEBP do WAV, que começa com o mesmo `RIFF`.
 */
export function farejarArquivoDaAbordagem(bytes: Uint8Array): string | null {
  if (comecaCom(bytes, PDF)) return "application/pdf";
  if (comecaCom(bytes, JPEG)) return "image/jpeg";
  if (comecaCom(bytes, PNG)) return "image/png";
  if (comecaCom(bytes, RIFF) && ascii(bytes, 8, 12) === String.fromCharCode(...WEBP))
    return "image/webp";
  // A caixa `ftyp` mora nos bytes 4..7; a marca (major brand) em 8..11.
  if (ascii(bytes, 4, 8) === "ftyp") return MARCAS_DE_VIDEO[ascii(bytes, 8, 12)] ?? null;
  return null;
}

/** O caminho no bucket da campanha: `{org}/prospecting/<uuid>.<ext>`. */
export function caminhoDoArquivoDaAbordagem(
  organizationId: string,
  id: string,
  mime: string,
): string | null {
  const extensao = EXTENSAO_DE[mime];
  if (!extensao) return null;
  return `${organizationId}/prospecting/${id}.${extensao}`;
}

export type DescritorDoArquivo =
  | { ok: true; midia: MidiaDaAbordagem }
  | { ok: false; codigo: "unsupported_media_type" | "validation_failed"; motivo: string };

/**
 * Os bytes viram o descritor que a configuração guarda — ou a recusa.
 *
 * Tipo primeiro (o farejador), depois a régua do envio (tipo e tamanho na mesma
 * função que o schema usa) e por último o caminho, que só existe para um mime
 * que a régua aceitou. Nada de rebaixar: o que não é imagem, vídeo ou PDF não
 * vira documento genérico.
 */
export function descreverArquivoDaAbordagem(args: {
  organizationId: string;
  id: string;
  bytes: Uint8Array;
}): DescritorDoArquivo {
  const { organizationId, id, bytes } = args;
  const mime = farejarArquivoDaAbordagem(bytes);
  if (!mime)
    return { ok: false, codigo: "unsupported_media_type", motivo: MOTIVO_DO_TIPO_DO_ARQUIVO };
  const caminho = caminhoDoArquivoDaAbordagem(organizationId, id, mime);
  if (!caminho)
    return { ok: false, codigo: "unsupported_media_type", motivo: MOTIVO_DO_TIPO_DO_ARQUIVO };
  const midia: MidiaDaAbordagem = {
    storage_path: caminho,
    media_mime: mime,
    media_size_bytes: bytes.length,
  };
  const classificada = classificarMidiaDaAbordagem(midia);
  if (!classificada.ok)
    return { ok: false, codigo: "validation_failed", motivo: MOTIVO_DO_TAMANHO_DO_ARQUIVO };
  return { ok: true, midia };
}
