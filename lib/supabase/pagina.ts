/**
 * Leitura de uma tabela por PÁGINAS, com o fim provado — nunca por página curta.
 *
 * ─── Por que existe ────────────────────────────────────────────────────────
 *
 * O PostgREST corta TODA resposta em `max_rows` (1000, `supabase/config.toml`)
 * sem erro nenhum: um `.limit(5000)` devolve 1000 linhas caladas, e um
 * `.select()` sem `.range()` devolve um pedaço arbitrário. Quem soma valor num
 * período e não pagina mostra um mês com 1.200 vendas como se fossem 1.000, e
 * não há como perceber isso na tela.
 *
 * O fim é provado pelo `count` exato da primeira página ou por página VAZIA —
 * nunca por página curta (`lib/agenda/protecao-followup.ts`): com `max_rows`
 * menor que a página, página curta não é fim. Quando o laço esgota as páginas
 * sem provar o fim, `truncado` sai `true` e a resposta avisa.
 *
 * Recebe uma FUNÇÃO que monta a consulta, não a consulta pronta, porque o
 * builder do supabase-js acumula os parâmetros e não pode receber `.range()`
 * duas vezes. A ordem descendente (coluna da janela, depois `id`) é o que
 * garante que o pedaço seja sempre o mais RECENTE — sem `.order()`, o PostgREST
 * devolve um pedaço arbitrário que muda de uma chamada para outra.
 */
export const TAMANHO_DA_PAGINA = 1000;
export const PAGINAS_MAXIMAS = 5;

export async function lerPaginado<T>(
  pagina: (
    inicio: number,
    fim: number,
    contar: boolean,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null; count: number | null }>,
): Promise<{ linhas: T[]; truncado: boolean; erro: string | null }> {
  const linhas: T[] = [];
  let total: number | null = null;
  for (let i = 0; i < PAGINAS_MAXIMAS; i++) {
    const { data, error, count } = await pagina(
      linhas.length,
      linhas.length + TAMANHO_DA_PAGINA - 1,
      i === 0,
    );
    if (error) return { linhas, truncado: false, erro: error.message };
    if (i === 0) total = count;
    const lote = data ?? [];
    linhas.push(...lote);
    if (lote.length === 0 || (total !== null && linhas.length >= total)) {
      return { linhas, truncado: false, erro: null };
    }
  }
  return { linhas, truncado: true, erro: null };
}
