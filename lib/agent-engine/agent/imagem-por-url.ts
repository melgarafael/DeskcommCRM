/**
 * `send_message` com `imagem_url`: a foto que veio de um RESULTADO DE FERRAMENTA
 * (ex.: uma receita do banco externo, Spec 25 R4).
 *
 * Diferente de `produto_codigo` (a foto é COPIADA do catálogo para a pasta da
 * conversa), aqui nada é copiado: a URL segue ao canal como `media.url` e o
 * gateway de mensageria a baixa. Por isso a guarda de rede anti-SSRF
 * (`assertUrlDeMidiaSegura`, Spec 25 C6) roda ANTES de qualquer envio, e é a
 * única barreira deste caminho.
 *
 * Falha de mídia nunca derruba o texto (Spec 25 D7): recusada, a mensagem sai só
 * com texto e o motivo volta ao modelo como `foto_recusada`.
 */
import { assertUrlDeMidiaSegura } from '@/lib/messaging/media/url-de-midia-externa';

import type { FotoParaEnvio } from './fotos-do-produto';

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

/** Foto por URL: não copiada para o Storage da conversa; o canal baixa pela URL. */
export interface FotoDeUrl {
  url: string;
  mime: string;
  type: 'image';
}

export type ImagemPorUrl = { ok: true; foto: FotoDeUrl } | { ok: false; motivo: string };

/**
 * Só o FORMATO da URL, sem rede: parseável e extensão do caminho em
 * jpg/jpeg/png/webp. O esquema (https, e http só fora de produção) não é
 * decidido aqui — é a guarda canônica que decide, em `prepararImagemPorUrl`.
 * Usado também pela prévia, que não faz rede.
 */
export function formatoDeImagemPorUrl(bruta: string): ImagemPorUrl {
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
  return { ok: true, foto: { url: bruta, mime, type: 'image' } };
}

/**
 * Formato + guarda de rede (C6). A guarda roda ANTES de qualquer envio. O motivo
 * que sai é o código curto da guarda (`unsafe_url:private_host`,
 * `unsafe_url:dns_failed`…), nunca a URL inteira.
 */
export async function prepararImagemPorUrl(bruta: string): Promise<ImagemPorUrl> {
  const pelaForma = formatoDeImagemPorUrl(bruta);
  if (!pelaForma.ok) return pelaForma;
  try {
    await assertUrlDeMidiaSegura(bruta);
  } catch (erro) {
    return { ok: false, motivo: erro instanceof Error ? erro.message : 'unsafe_url' };
  }
  return pelaForma;
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

/** A forma que o canal recebe em `media`: URL para foto por URL, caminho para a do catálogo. */
export function paraMidiaDoCanal(foto: FotoParaEnvio | FotoDeUrl) {
  return 'url' in foto
    ? { url: foto.url, mime: foto.mime, type: 'image' as const }
    : { storagePath: foto.storagePath, mime: foto.mime };
}
