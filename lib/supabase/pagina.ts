import { IDS_POR_LOTE } from "./em-lotes";

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

/**
 * A MESMA prova de fim, aplicada a cada LOTE de um `.in(coluna, ids)`.
 *
 * ─── Por que existe (#4321, a metade que sobrou) ───────────────────────────
 *
 * `buscaEmLotes` (`lib/supabase/em-lotes.ts`) quebra o `.in()` em lotes de 100
 * ids — pelo teto de URL do header, não pelo `max_rows`. Só que CADA lote
 * continua sendo UMA consulta sem `.range()`: o PostgREST corta aquele lote em
 * 1.000 linhas caladas. Para as leituras 1:1 (um contato, um score, um
 * `lead_state`) 100 ids nunca passam de 100 linhas e o corte não existe. Para
 * as que crescem COM O FILHO — `crm_tasks` de cada negócio,
 * `crm_lead_attachments` de cada campo `file` — 100 negócios passam de mil
 * linhas com folga, e o quadro perdia o selo de tarefas (ou o anexo) dos
 * últimos cards do lote sem dizer nada.
 *
 * A ordem de cada lote é responsabilidade de quem chama (a coluna da janela e,
 * no fim, `id`): é ela que faz a página seguinte ser determinística.
 *
 * `truncado` só é `true` quando ALGUM lote esgotou `PAGINAS_MAXIMAS` páginas
 * sem provar o fim — quem chama decide se avisa (o quadro avisa, no
 * `truncado` do corpo).
 */
export async function lerPaginadoEmLotes<T>(
  ids: readonly string[],
  pagina: (
    lote: string[],
    inicio: number,
    fim: number,
    contar: boolean,
  ) => PromiseLike<{
    data: T[] | null;
    error: { message: string } | null;
    count: number | null;
  }>,
): Promise<{ linhas: T[]; truncado: boolean; erro: string | null }> {
  if (ids.length === 0) return { linhas: [], truncado: false, erro: null };
  const linhas: T[] = [];
  let truncado = false;
  for (let i = 0; i < ids.length; i += IDS_POR_LOTE) {
    const lote = ids.slice(i, i + IDS_POR_LOTE);
    const r = await lerPaginado<T>((inicio, fim, contar) => pagina(lote, inicio, fim, contar));
    if (r.erro) return { linhas, truncado: false, erro: r.erro };
    linhas.push(...r.linhas);
    if (r.truncado) truncado = true;
  }
  return { linhas, truncado, erro: null };
}
