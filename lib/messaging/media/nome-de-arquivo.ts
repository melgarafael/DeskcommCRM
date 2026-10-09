/**
 * Nome original de um anexo recebido, pronto para ser gravado e exibido (#2613).
 *
 * O nome vem de fora (do aparelho de quem mandou), então passa por aqui antes de
 * virar `metadata.media_filename` e antes de virar rótulo no Inbox: caracteres
 * de controle e de formatação de direção de texto saem, as pontas são aparadas e
 * o tamanho tem teto. Guarda por VALOR: não-string, vazio ou só-invisível → null.
 */
const INVISIVEIS = /[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/** Teto em caracteres (code points) — o limite usual de nome de arquivo. */
export const NOME_DE_ARQUIVO_MAX = 255;

export function nomeDeArquivoLimpo(bruto: unknown): string | null {
  if (typeof bruto !== "string") return null;
  const nome = Array.from(bruto.replace(INVISIVEIS, "").trim())
    .slice(0, NOME_DE_ARQUIVO_MAX)
    .join("")
    .trim();
  return nome ? nome : null;
}
