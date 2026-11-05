/**
 * `send_message` com `imagem_url`: a foto que veio de um RESULTADO DE FERRAMENTA
 * (ex.: uma receita do banco externo, Spec 25 R4).
 *
 * Opção A (decisão do dono): o CRM baixa a imagem com a própria rede
 * (`baixar-imagem-segura.ts`), confere o conteúdo, guarda no Storage da conversa
 * (`guardarImagemNaConversa`) e manda ao canal só o `storagePath`, exatamente
 * como a foto do catálogo. O gateway de mensageria nunca recebe a URL da fonte.
 *
 * Aqui fica só o que a prévia e a extensão precisam: o formato da URL, sem rede,
 * e a procedência da URL dentro do turno.
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

/**
 * Ferramentas cujo resultado pode trazer o endereço de uma foto: o banco externo e o
 * catálogo. O resultado de outras (conversa, contato, notas) pode repetir o que o
 * contato escreveu, então não conta.
 */
export const FERRAMENTAS_QUE_TRAZEM_IMAGEM: ReadonlySet<string> = new Set([
  'crm_consultar_receita',
  'crm_query_external_data',
  'crm_search_products',
]);

/** Termina fora de pontuação: em texto corrido, o ponto final não faz parte do endereço. */
const URL_NO_TEXTO = /https?:\/\/[^\s"'<>\\]*[^\s"'<>\\.,;:!?)\]}]/gi;

const urlsEm = (valor: unknown): string[] => JSON.stringify(valor ?? null).match(URL_NO_TEXTO) ?? [];

/**
 * Os endereços que as ferramentas de dados devolveram NESTE turno. O `send_message`
 * só busca uma `imagem_url` que esteja aqui, igual, letra por letra. Endereço que
 * também estava nos argumentos da chamada não conta: é o pedido voltando na resposta,
 * não um dado que a ferramenta trouxe.
 */
export function criarProcedenciaDeImagens() {
  const vistas = new Set<string>();
  return {
    registrar(resultado: unknown, argumentos: unknown) {
      const pedidas = new Set(urlsEm(argumentos));
      for (const url of urlsEm(resultado)) if (!pedidas.has(url)) vistas.add(url);
    },
    viu: (url: string) => vistas.has(url),
  };
}
