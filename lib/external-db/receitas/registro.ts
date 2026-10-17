/**
 * REGISTRO DE RECEITAS: mapa id → definição. Nada de `if` por provedor fora
 * desta pasta — quem quer uma receita chama `receitaDe(id)`.
 */
import { RECEITA_ACF_IMOVEIS } from "./acf-imoveis";
import { RECEITA_WOOCOMMERCE_PRODUTOS } from "./woocommerce";
import type { DefinicaoDeReceita } from "./tipos";

/** Todas as receitas prontas, pelo id. Começa com woocommerce (fatia R1) e acf-imoveis (fatia R2). */
export const RECEITAS: ReadonlyMap<string, DefinicaoDeReceita> = new Map([
  [RECEITA_WOOCOMMERCE_PRODUTOS.id, RECEITA_WOOCOMMERCE_PRODUTOS],
  [RECEITA_ACF_IMOVEIS.id, RECEITA_ACF_IMOVEIS],
]);

/** Os ids de todas as receitas (para o enum do Zod nas instâncias). */
export const IDS_DAS_RECEITAS: readonly string[] = [...RECEITAS.keys()];

/** A receita pelo id, ou undefined se não existir. */
export function receitaDe(id: string): DefinicaoDeReceita | undefined {
  return RECEITAS.get(id);
}
