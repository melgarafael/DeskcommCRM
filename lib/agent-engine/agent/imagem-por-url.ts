/**
 * `send_message` com `imagem_url`: a foto que veio de um RESULTADO DE FERRAMENTA
 * (ex.: uma receita do banco externo, Spec 25 R4).
 *
 * Revisão à D7 aceita na triagem (Spec 25): o CRM baixa a imagem com a própria
 * rede (`baixar-imagem-segura.ts`), confere o conteúdo, guarda no Storage da conversa
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
 * Ferramentas cujo resultado pode trazer o endereço de uma foto: as duas que leem o
 * banco externo. O catálogo fica de fora: `crm_search_products` devolve só a contagem
 * de `fotos`, e a foto dele sai por `produto_codigo`.
 */
export const FERRAMENTAS_QUE_TRAZEM_IMAGEM: ReadonlySet<string> = new Set([
  'crm_consultar_receita',
  'crm_query_external_data',
]);

const ENDERECO_INTEIRO = /^https?:\/\/\S+$/i;

/**
 * Os campos que SÃO um endereço, em qualquer profundidade. Endereço no meio de um
 * texto não conta. As ferramentas devolvem objeto, não texto serializado.
 */
function enderecosEm(valor: unknown): string[] {
  if (typeof valor === 'string') {
    const texto = valor.trim();
    return ENDERECO_INTEIRO.test(texto) ? [texto] : [];
  }
  if (valor === null || typeof valor !== 'object') return [];
  return Object.values(valor).flatMap(enderecosEm);
}

/**
 * Os endereços que as ferramentas de dados devolveram NESTE turno. O `send_message`
 * só busca uma `imagem_url` que esteja aqui, igual, letra por letra. Endereço que
 * também estava nos argumentos da chamada não conta: é o pedido voltando na resposta,
 * não um dado que a ferramenta trouxe. Célula com vários endereços (galeria) não
 * autoriza nenhum deles: separá-los é da fatia que trouxer a foto de uma lista.
 */
export function criarProcedenciaDeImagens() {
  const vistas = new Set<string>();
  return {
    registrar(resultado: unknown, argumentos: unknown) {
      const pedidas = new Set(enderecosEm(argumentos));
      for (const url of enderecosEm(resultado)) if (!pedidas.has(url)) vistas.add(url);
    },
    viu: (url: string) => vistas.has(url),
  };
}
