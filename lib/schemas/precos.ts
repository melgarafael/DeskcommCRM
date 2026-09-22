import { z } from "zod";

/**
 * O CONTRATO DE CATEGORIAS E TABELAS DE PREÇO — um só, lido pela tela E pela rota.
 *
 * Mesma doutrina de `lib/schemas/produtos.ts`.
 */

export const categoriaCreateSchema = z.object({
  nome: z.string().trim().min(2, "o nome precisa de ao menos 2 letras").max(80),
  parent_id: z.string().uuid().nullable().optional(),
  posicao: z.number().int().min(0).default(0),
  ativo: z.boolean().default(true),
});

export const categoriaPatchSchema = categoriaCreateSchema.partial();

export type CategoriaCreate = z.infer<typeof categoriaCreateSchema>;
export type CategoriaPatch = z.infer<typeof categoriaPatchSchema>;

export interface Categoria {
  id: string;
  parent_id: string | null;
  nome: string;
  posicao: number;
  ativo: boolean;
  updated_at: string;
}

export const COLUNAS_DA_CATEGORIA = "id, parent_id, nome, posicao, ativo, updated_at";

export const tabelaCreateSchema = z.object({
  nome: z.string().trim().min(2, "o nome precisa de ao menos 2 letras").max(80),
  desconto_pct: z.number().min(0).max(100).default(0),
  padrao: z.boolean().default(false),
  ativo: z.boolean().default(true),
});

export const tabelaPatchSchema = tabelaCreateSchema.partial();

export type TabelaCreate = z.infer<typeof tabelaCreateSchema>;
export type TabelaPatch = z.infer<typeof tabelaPatchSchema>;

export interface TabelaDePreco {
  id: string;
  nome: string;
  desconto_pct: number;
  padrao: boolean;
  ativo: boolean;
  updated_at: string;
}

export const COLUNAS_DA_TABELA = "id, nome, desconto_pct, padrao, ativo, updated_at";

/** Um item: preço final do produto nesta tabela (NULL = vale o desconto padrão). */
export const itemDeTabelaSchema = z.object({
  product_id: z.string().uuid(),
  preco_cents: z.number().int().min(0).nullable(),
});

export type ItemDeTabela = z.infer<typeof itemDeTabelaSchema>;

export interface ItemDeTabelaSalvo extends ItemDeTabela {
  id: string;
}

export const COLUNAS_DO_ITEM_DE_TABELA = "id, product_id, preco_cents";

/**
 * Preço efetivo de venda: item da tabela > desconto da tabela sobre a base >
 * preço base. É a regra documentada na 0210, aplicada na rota de pedidos e na
 * tela de novo pedido — nunca em trigger.
 */
export function precoEfetivo(
  precoBaseCents: number,
  descontoTabelaPct: number,
  precoItemCents: number | null,
): number {
  if (precoItemCents !== null) return precoItemCents;
  return Math.round(precoBaseCents * (1 - descontoTabelaPct / 100));
}
