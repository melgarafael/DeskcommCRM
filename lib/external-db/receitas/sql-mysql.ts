/**
 * Funções de escape para MySQL, em um só lugar para ser reutilizado por todas
 * as famílias de receitas (woocommerce hoje; acf-imoveis, jetengine-imoveis,
 * tabela-direta amanhã em R2/R3).
 *
 * Nunca concatenar valor cru no SQL: identificadores vão por crase (com crase
 * interna dobrada) e valores de LIKE vão por placeholder `?` após escapar
 * os curingas `!`, `%` e `_` com o escape `!`.
 */

export function quotarIdentificadorMysql(nome: string): string {
  return `\`${nome.replace(/`/g, "``")}\``;
}

export function escaparLikeMysql(valor: string): string {
  return valor.replace(/!/g, "!!").replace(/%/g, "!%").replace(/_/g, "!_");
}
