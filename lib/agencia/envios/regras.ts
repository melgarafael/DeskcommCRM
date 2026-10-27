/**
 * As regras puras dos Envios (docs/agencia/SPEC-envios.md). Sem banco e sem rede:
 * a tela, as ações e o motor da cópia leem daqui.
 */
import type { Subpasta } from "../acervo/pastas";
import type { TipoDeAprovacao } from "../aprovacoes/vocabulario";

export const BUCKET_DOS_ENVIOS = "agencia-envios";

/** E2: 2 GB por vídeo — o teto do bucket e do Storage da instalação. */
export const TAMANHO_MAXIMO_DO_VIDEO = 2 * 1024 * 1024 * 1024;
export const TAMANHO_MAXIMO_DA_IMAGEM = 50 * 1024 * 1024;
export const TAMANHO_MAXIMO_DO_PDF = 50 * 1024 * 1024;
/** E3: o Storage do Supabase só aceita partes de exatamente 6 MB no TUS (a última pode ser menor). */
export const PARTE_DO_ENVIO = 6 * 1024 * 1024;

export const MIMES_DE_VIDEO = ["video/mp4", "video/quicktime", "video/webm"] as const;
export const MIMES_DE_IMAGEM = ["image/jpeg", "image/png", "image/webp"] as const;
export const MIME_DE_PDF = "application/pdf";

const EXTENSAO: Record<string, string> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

export type FormaDoMaterial = "arquivo" | "texto" | "link";

/** O que cada tipo aceita como material (E2). O link segue aceito para não quebrar o que já existe. */
export const FORMAS_DO_TIPO: Record<TipoDeAprovacao, readonly FormaDoMaterial[]> = {
  video: ["arquivo", "link"],
  arte: ["arquivo", "link"],
  roteiro: ["texto", "link"],
  estrategia: ["texto", "arquivo", "link"],
  outro: ["texto", "arquivo", "link"],
  aviso: ["texto"],
};

/** Por que este arquivo não serve para este tipo — ou null quando serve. */
export function problemaNoArquivo(tipo: TipoDeAprovacao, mime: string, bytes: number): string | null {
  if (!FORMAS_DO_TIPO[tipo].includes("arquivo")) return "Este tipo de envio não leva arquivo.";
  if (!Number.isFinite(bytes) || bytes <= 0) return "O arquivo está vazio.";
  const video = (MIMES_DE_VIDEO as readonly string[]).includes(mime);
  const imagem = (MIMES_DE_IMAGEM as readonly string[]).includes(mime);
  const pdf = mime === MIME_DE_PDF;
  if (tipo === "video" && !video) return "Vídeo precisa ser .mp4, .mov ou .webm.";
  if (tipo === "arte" && !imagem) return "Arte precisa ser .jpg, .png ou .webp.";
  if (!video && !imagem && !pdf) return "Formato não aceito: use vídeo (.mp4, .mov, .webm), imagem (.jpg, .png, .webp) ou PDF.";
  if (video && bytes > TAMANHO_MAXIMO_DO_VIDEO) return "O vídeo passa de 2 GB.";
  if (imagem && bytes > TAMANHO_MAXIMO_DA_IMAGEM) return "A imagem passa de 50 MB.";
  if (pdf && bytes > TAMANHO_MAXIMO_DO_PDF) return "O PDF passa de 50 MB.";
  return null;
}

/** O caminho no bucket: `<cliente>/<uuid>.<ext>`. O nome original fica só na coluna, nunca no caminho. */
export function caminhoDoEnvio(clienteId: string, uuid: string, mime: string): string {
  return `${clienteId}/${uuid}.${EXTENSAO[mime] ?? "bin"}`;
}

/** O caminho é deste cliente e não sai da pasta dele. */
export function caminhoEhDoCliente(caminho: string, clienteId: string): boolean {
  return caminho.startsWith(`${clienteId}/`) && !caminho.includes("..") && /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.[a-z0-9]{2,4}$/.test(caminho);
}

/** E6: onde a cópia aprovada mora no Drive do cliente. */
export function subpastaDoEnvio(tipo: TipoDeAprovacao): Subpasta | null {
  if (tipo === "video") return "06 Edições";
  if (tipo === "arte") return "07 Artes";
  if (tipo === "roteiro" || tipo === "estrategia" || tipo === "outro") return "03 Planejamento";
  return null;
}

/** Nome do arquivo no Drive: data + título + versão, sem caractere que o Drive estranhe. */
export function nomeNoDrive(p: { titulo: string; versao: number; dia: string; extensao: string }): string {
  const limpo = p.titulo.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 100) || "Envio";
  return `${p.dia} ${limpo}${p.versao > 1 ? ` (v${p.versao})` : ""}.${p.extensao}`;
}

/** E6: o próximo pedaço da cópia — múltiplo de 256 KB, como o Drive exige (o último pode ser menor). */
export const PEDACO_DA_COPIA = 32 * 1024 * 1024;
export function proximoPedaco(enviados: number, total: number): { inicio: number; fim: number; ultimo: boolean } | null {
  if (enviados >= total) return null;
  const fim = Math.min(enviados + PEDACO_DA_COPIA, total) - 1;
  return { inicio: enviados, fim, ultimo: fim === total - 1 };
}

export function formatarTamanho(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2).replace(".", ",")} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
