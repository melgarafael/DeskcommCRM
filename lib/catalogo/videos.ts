/**
 * OS VÍDEOS DO PRODUTO — regras para upload, validação e entrega no WhatsApp.
 *
 * Bucket privado `catalog-videos`. O caminho segue o padrão:
 * `<organization_id>/<produto_id>/<uuid>.mp4`
 */

export const BUCKET_DOS_VIDEOS = "catalog-videos";

/** 300 MB: teto para recebimento no upload antes de transcodificação/otimização. */
export const TAMANHO_MAXIMO_DO_VIDEO = 300 * 1024 * 1024;

/** 16 MB: teto recomendado para stream direto nativo inline no WhatsApp (sem virar anexo). */
export const TAMANHO_OTIMO_WHATSAPP_VIDEO = 16 * 1024 * 1024;

/**
 * Confere se o caminho do vídeo pertence à organização e ao produto especificados.
 */
export function videoPertenceAoProduto(caminho: string, orgId: string, produtoId: string): boolean {
  const prefixo = `${orgId}/${produtoId}/`;
  if (!caminho || !caminho.startsWith(prefixo)) return false;
  const resto = caminho.slice(prefixo.length);
  return !resto.includes("..") && resto.length > 0;
}
