/**
 * O nome do arquivo no DOWNLOAD (#2613).
 *
 * O cartão do Inbox já mostrava o nome original, mas o arquivo salvo chegava
 * como `{uuid}.xlsx`: quando a mídia está persistida a rota responde 302 para a
 * URL assinada do Storage, e o nome só sobrevive se viajar no
 * `Content-Disposition`. É esse cabeçalho que este arquivo monta.
 *
 * Duas formas do MESMO nome, porque nenhuma sozinha serve:
 *
 *   · `filename="..."` — ASCII, para cliente antigo que não entende RFC 5987.
 *     Acentos caem pela decomposição NFD (`Relatório` → `Relatorio`) e o que
 *     ainda não for imprimível vira `_`; aspas e barra invertida viram `_` para
 *     não fechar a string antes da hora.
 *   · `filename*=UTF-8''...` — o nome de verdade, percent-encoded. É o que o
 *     navegador de hoje usa: o arquivo chega com o nome que o cliente mandou.
 *
 * Não inventa nada: quem chama só monta o cabeçalho quando TEM o nome original
 * (`nomeOriginalDaMensagem`), e a ausência dele significa "nada a nomear", não
 * "invente um".
 */
export function cabecalhoDeDownload(nome: string): string {
  const semAcento = nome.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const ascii = semAcento.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  // `encodeURIComponent` deixa `'`, `(`, `)` e `*` crus; a RFC 5987 pede
  // percent-encoding neles (attr-char não os inclui).
  const codificado = encodeURIComponent(nome).replace(/['()*]/g, (c) =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${codificado}`;
}

/**
 * O SDK do Storage codifica a URL inteira depois de montar `download` com
 * URLSearchParams. Isso duplica escapes de acentos, `%` e outros caracteres.
 * Recompomos só esse parâmetro com o nome original: objeto e token continuam
 * os da assinatura, sem decodificar a URL inteira nem usar o nome como path.
 */
export function urlAssinadaParaDownload(urlAssinada: string, nome: string): string {
  const destino = new URL(urlAssinada);
  destino.searchParams.set("download", nome);
  return destino.toString();
}
