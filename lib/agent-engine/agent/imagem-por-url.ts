/**
 * `send_message` com `imagem_url`: a foto que veio de um RESULTADO DE FERRAMENTA
 * (ex.: uma receita do banco externo, Spec 25 R4).
 *
 * Opção A (decisão do dono): o CRM baixa a imagem com a própria rede
 * (`baixar-imagem-segura.ts`), confere o conteúdo, guarda no Storage da conversa
 * (`guardarImagemNaConversa`) e manda ao canal só o `storagePath`, exatamente
 * como a foto do catálogo. O gateway de mensageria nunca recebe a URL da fonte.
 *
 * Aqui fica só o que a prévia e a extensão precisam: o formato da URL, sem rede.
 */

/**
 * Extensão do CAMINHO da URL → MIME. Query-string e fragmento não entram na decisão.
 * `Map` e não objeto literal: com objeto, `constructor` ou `__proto__` virariam "aceitos".
 */
const MIME_POR_EXTENSAO_DE_IMAGEM = new Map<string, string>([
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['png', 'image/png'],
  ['webp', 'image/webp'],
]);

export type FormatoDeImagemPorUrl =
  | { ok: true; mime: string; extensao: string }
  | { ok: false; motivo: string };

/**
 * Só o FORMATO da URL, sem rede: parseável e extensão do caminho em
 * jpg/jpeg/png/webp. O esquema e o destino são decididos por
 * `baixarImagemSegura`, que usa a guarda canônica de saída. Usado também pela
 * prévia, que não faz rede nem upload.
 */
export function formatoDeImagemPorUrl(bruta: string): FormatoDeImagemPorUrl {
  let url: URL;
  try {
    url = new URL(bruta);
  } catch {
    return { ok: false, motivo: 'url_invalida' };
  }
  const ultimo = url.pathname.split('/').pop() ?? '';
  const ponto = ultimo.lastIndexOf('.');
  const extensao = ponto < 0 ? '' : ultimo.slice(ponto + 1).toLowerCase();
  const mime = MIME_POR_EXTENSAO_DE_IMAGEM.get(extensao);
  if (!mime) return { ok: false, motivo: 'extensao_nao_aceita' };
  return { ok: true, mime, extensao };
}

/**
 * Host + caminho, sem query nem fragmento: é o que pode ir ao log. A query de
 * uma URL assinada leva token, e não entra em log.
 */
export function descreverSemQuery(bruta: string): string {
  try {
    const url = new URL(bruta);
    return `${url.host}${url.pathname}`;
  } catch {
    return '(url inválida)';
  }
}
