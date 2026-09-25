/**
 * Consulta com `.in(coluna, ids)` quebrada em lotes — para listas que crescem
 * com o tamanho da organização.
 *
 * O PostgREST DEVOLVE a query inteira no header `Content-Location` da resposta.
 * Com ~400 uuids num `.in()` esse header passa de 16 KB, que é o teto padrão de
 * header do Node (`--max-http-header-size`): o `fetch` do supabase-js falha com
 * `UND_ERR_HEADERS_OVERFLOW` ANTES de ler o corpo, e o erro chega como
 * "TypeError: fetch failed" — sem dizer que o problema é tamanho. Foi assim que
 * o quadro de um funil com 415 leads parou de abrir.
 *
 * 100 uuids ≈ 3,7 KB de URL: folga larga para os outros filtros da consulta.
 *
 * A ordem do resultado é a de cada lote, concatenada. Quem depende de ordem
 * GLOBAL tem que reordenar; ordem DENTRO de um mesmo valor da coluna do `.in()`
 * (ex.: conversas de um contato) sobrevive, porque cada valor cai num lote só.
 */
export const IDS_POR_LOTE = 100;

export async function buscaEmLotes<T>(
  ids: readonly string[],
  consulta: (lote: string[]) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<{ data: T[]; error: { message: string } | null }> {
  if (ids.length === 0) return { data: [], error: null };
  const lotes: string[][] = [];
  for (let i = 0; i < ids.length; i += IDS_POR_LOTE) {
    lotes.push(ids.slice(i, i + IDS_POR_LOTE));
  }
  const respostas = await Promise.all(lotes.map((lote) => consulta(lote)));
  const data: T[] = [];
  for (const r of respostas) {
    if (r.error) return { data: [], error: r.error };
    data.push(...(r.data ?? []));
  }
  return { data, error: null };
}
