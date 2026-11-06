/**
 * TAXONOMIA do WordPress — as três tabelas que guardam "categorias".
 *
 * No WordPress, categoria NÃO é campo: é uma LINHA em `terms` (o nome), uma
 * linha em `term_taxonomy` (a que taxonomia é e qual é o pai) e uma linha em
 * `term_relationships` (que post tem aquele termo). Uma imobiliária que
 * organiza o site por "Cidade › Bairro" tem o termo `Sorocaba` (sem pai) e o
 * termo `Centro` (pai = Sorocaba) — e o bairro do imóvel é o TERMO, não uma
 * meta_key.
 *
 * Por isso a receita `wordpress-conteudo` precisa destas tabelas. E por isso
 * elas só entram na lista de tabelas liberadas quando o administrador mapeou
 * ALGUMA categoria: quem não usa categoria não precisa liberá-las.
 *
 * **Três coisas que este arquivo resolve e a receita não:**
 *
 *  1. A SAÍDA: um post pode ter DOIS termos na mesma taxonomia. A saída usa
 *     `group_concat`, que junta os nomes numa única célula — o post aparece
 *     UMA vez na lista, com "Centro, Jardim" no lugar do bairro, e não duas
 *     linhas.
 *  2. O FILTRO: `exists (...)` com o mesmo encadeamento de tabelas, para não
 *     duplicar a linha do post no resultado.
 *  3. O NÍVEL: "bairro" costuma ser o termo que TEM cidade acima (`parent <> 0`)
 *     e "cidade" o termo que NÃO tem (`parent = 0`). Sem o nível, o filtro por
 *     bairro acharia também a cidade, e o filtro por cidade acharia o bairro.
 *
 * A receita mapeia as categorias por LISTA (cada uma com a sua chave, a sua
 * taxonomia e o seu nível) — não por um conjunto fixo de nomes: o conjunto
 * fixo era o que prendia a receita a um nicho.
 *
 * Identificadores (nomes de tabela) entram no SQL por crase, depois de validados
 * pela regex do prefixo; TODO valor (o slug da taxonomia, o texto do filtro)
 * entra por placeholder `?`.
 */
import { escaparLikeMysql, quotarIdentificadorMysql } from "./sql-mysql";

/**
 * O nível do termo dentro da hierarquia:
 *  - `qualquer`: tanto faz (padrão).
 *  - `filho`: só termos que TÊM um termo acima (o bairro, quando a cidade é o pai).
 *  - `raiz`: só termos que NÃO têm termo acima (a cidade).
 */
export type NivelDaTaxonomia = "qualquer" | "filho" | "raiz";

/** As três tabelas de taxonomia, com o prefixo aplicado. */
export function tabelasDaTaxonomia(prefixo: string): string[] {
  return [`${prefixo}terms`, `${prefixo}term_taxonomy`, `${prefixo}term_relationships`];
}

/**
 * As colunas que a receita usa de cada tabela de taxonomia. Só as USADAS:
 * em modo `list` o administrador precisa liberar exatamente estas — pedir
 * uma coluna a mais seria exigir liberação sem uso.
 */
export function colunasDaTaxonomia(prefixo: string): Record<string, string[]> {
  return {
    [`${prefixo}terms`]: ["term_id", "name", "slug"],
    [`${prefixo}term_taxonomy`]: ["term_taxonomy_id", "term_id", "taxonomy", "parent"],
    [`${prefixo}term_relationships`]: ["object_id", "term_taxonomy_id"],
  };
}

/**
 * O contexto que as duas montagens de SQL precisam: prefixo, o post e o placeholder.
 */
export interface ContextoDeTaxonomia {
  /** O prefixo das tabelas do WordPress (ex.: "wp_"). */
  prefixo: string;
  /** A coluna que identifica o post (ex.: "p.ID"). */
  objeto: string;
  /** Empurra o valor na lista de valores e devolve o placeholder "?". */
  marcador: (valor: unknown) => string;
}

/** O predicado de nível — some quando o nível é "qualquer". */
function clausulaDeNivel(nivel: NivelDaTaxonomia | undefined): string {
  if (nivel === "filho") return " and tt.parent <> 0";
  if (nivel === "raiz") return " and tt.parent = 0";
  return "";
}

/** O encadeamento `term_relationships → term_taxonomy → terms`, com os apelidos fixos. */
function encadeamento(ctx: ContextoDeTaxonomia): { tr: string; tt: string; t: string } {
  return {
    tr: quotarIdentificadorMysql(`${ctx.prefixo}term_relationships`),
    tt: quotarIdentificadorMysql(`${ctx.prefixo}term_taxonomy`),
    t: quotarIdentificadorMysql(`${ctx.prefixo}terms`),
  };
}

/**
 * A SUÍDA de uma categoria: uma subconsulta escalar que junta os nomes dos
 * termos do post numa única célula.
 *
 * `group_concat` é o que garante que um imóvel com DOIS termos na mesma
 * taxonomia (ex.: "Centro" e "Jardim") saia em UMA linha, e não em duas.
 */
export function subqueryDeTermos(
  ctx: ContextoDeTaxonomia,
  taxonomia: string,
  nivel: NivelDaTaxonomia | undefined,
): string {
  const { tr, tt, t } = encadeamento(ctx);
  return (
    `(select group_concat(t.name order by t.name separator ', ') ` +
    `from ${tr} tr join ${tt} tt on tt.term_taxonomy_id = tr.term_taxonomy_id ` +
    `join ${t} t on t.term_id = tt.term_id ` +
    `where tr.object_id = ${ctx.objeto} and tt.taxonomy = ${ctx.marcador(taxonomia)}${clausulaDeNivel(nivel)})`
  );
}

/**
 * Como o filtro casa com o termo da categoria.
 *
 *  - `contem`: pelo PEDÇO do texto — o bairro "Centro" casa com "centro". É o
 *    que bairro, cidade e tipo usam: a pessoa digita "asa norte" e o termo
 *    "Asa Norte" tem que aparecer.
 *  - `igualdade`: o termo É o valor — a finalidade "venda" casa com o termo de
 *    nome "Venda" ou de slug "venda", e com NADA mais. Um termo "Venda e
 *    Aluguel" não é "aluguel": com pedaço de texto, ele casava com os dois e a
 *    busca por finalidade devolvia imóvel errado.
 */
export type ModoDeTermo = "contem" | "igualdade";

/**
 * O FILTRO de uma categoria: `exists (...)` com o mesmo encadeamento.
 *
 * `exists` (e não `join`) porque o filtro NÃO pode multiplicar a linha do
 * imóvel: quem tem dois termos que casam com o filtro continua saindo uma vez.
 *
 * No modo `igualdade` (a finalidade) o termo casa pelo NOME ou pelo SLUG, por
 * igualdade: o slug é exatamente "venda"/"aluguel" e o nome costuma ser
 * "Venda"/"Aluguel". No modo `contem` (bairro, cidade e tipo) o nome casa pelo
 * pedaço do texto, e o slug não entra: o slug é técnico ("sorocaba-centro") e
 * ninguém digita ele.
 */
export function clausulaDeTermo(
  ctx: ContextoDeTaxonomia,
  taxonomia: string,
  nivel: NivelDaTaxonomia | undefined,
  valor: string,
  modo: ModoDeTermo,
): string {
  const { tr, tt, t } = encadeamento(ctx);
  // A ORDEM dos `marcador()` é a ORDEM dos `?` no texto: a taxonomia vem
  // primeiro, depois o nome e por último o slug. Calcular o texto antes de
  // computar os marcadores inverteria a lista de valores.
  const marcaTaxonomia = ctx.marcador(taxonomia);
  if (modo === "igualdade") {
    const exato = valor.toLowerCase();
    const marcaNome = ctx.marcador(exato);
    const marcaSlug = ctx.marcador(exato);
    return (
      `exists (select 1 from ${tr} tr join ${tt} tt on tt.term_taxonomy_id = tr.term_taxonomy_id ` +
      `join ${t} t on t.term_id = tt.term_id ` +
      `where tr.object_id = ${ctx.objeto} and tt.taxonomy = ${marcaTaxonomia}${clausulaDeNivel(nivel)} ` +
      `and (lower(t.name) = ${marcaNome} or lower(t.slug) = ${marcaSlug}))`
    );
  }
  const marcaNome = ctx.marcador(alvoDeLike(valor));
  return (
    `exists (select 1 from ${tr} tr join ${tt} tt on tt.term_taxonomy_id = tr.term_taxonomy_id ` +
    `join ${t} t on t.term_id = tt.term_id ` +
    `where tr.object_id = ${ctx.objeto} and tt.taxonomy = ${marcaTaxonomia}${clausulaDeNivel(nivel)} ` +
    `and lower(t.name) like ${marcaNome} escape '!')`
  );
}

/** O alvo de um LIKE com os curingas do valor escapados (`!` é o escape do MySQL). */
export function alvoDeLike(valor: string): string {
  return `%${escaparLikeMysql(valor.toLowerCase())}%`;
}
