/**
 * REGISTRO DE RECEITAS: mapa id → definição. Nada de `if` por provedor fora
 * desta pasta — quem quer uma receita chama `receitaDe(id)`.
 */
import { RECEITA_WOOCOMMERCE_PRODUTOS } from "./woocommerce";
import { RECEITA_WORDPRESS_CONTEUDO } from "./wordpress-conteudo";
import { RECEITA_TABELA_DIRETA } from "./tabela-direta";
import type { DefinicaoDeReceita } from "./tipos";

/** Todas as receitas prontas, pelo id. Começa com woocommerce (R1), o conteúdo do WordPress (R2) e a tabela direta (R3). */
export const RECEITAS: ReadonlyMap<string, DefinicaoDeReceita> = new Map([
  [RECEITA_WOOCOMMERCE_PRODUTOS.id, RECEITA_WOOCOMMERCE_PRODUTOS],
  [RECEITA_WORDPRESS_CONTEUDO.id, RECEITA_WORDPRESS_CONTEUDO],
  [RECEITA_TABELA_DIRETA.id, RECEITA_TABELA_DIRETA],
]);

/** Os ids de todas as receitas (para o enum do Zod nas instâncias). */
export const IDS_DAS_RECEITAS: readonly string[] = [...RECEITAS.keys()];

/** A receita pelo id, ou undefined se não existir. */
export function receitaDe(id: string): DefinicaoDeReceita | undefined {
  return RECEITAS.get(id);
}
