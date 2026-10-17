/**
 * Receita `woocommerce-produtos`: JOIN `<prefixo>posts` + `<prefixo>postmeta`
 * do WordPress/WooCommerce, uma linha por produto publicado.
 *
 * O JOIN lê:
 *  - `<prefixo>posts` — post_type = 'product', post_status = 'publish'
 *  - `<prefixo>postmeta` — metas _price, _regular_price, _sku, _stock_status
 *
 * Resultado por produto: id, título, preço, SKU, estoque, link (guid).
 *
 * O prefixo entra no SQL SOMENTE via quotar com crase, depois de validado pela
 * regex `^[A-Za-z0-9_]{1,20}$`. Todo valor vai por placeholder `?`.
 * Nunca concatenação.
 */
import { z } from "zod";

import type { DefinicaoDeReceita } from "./tipos";

const PREFIXO_PADRAO = "wp_";
const PREFIXO_REGEX = /^[A-Za-z0-9_]{1,20}$/;

/** Teto desta fatia: o C2 (custo em tokens de uma resposta de receita) não foi medido. */
export const TETO_ITENS_WOOCOMMERCE = 5;

const prefixoSchema = z
  .string()
  .min(1)
  .max(20)
  .regex(PREFIXO_REGEX, "Use apenas letras, números e underline no prefixo.")
  .default(PREFIXO_PADRAO);

/** O que o admin preenche na tela: o prefixo das tabelas do WordPress. */
export const PARAMETROS_FIXOS_WOOCOMMERCE = z
  .object({
    prefixo: prefixoSchema,
  })
  .strict();

/** O que o agente preenche na conversa. */
export const PARAMETROS_DA_BUSCA_WOOCOMMERCE = z
  .object({
    /** Trecho do título ou do SKU (até 80 chars). Vira LIKE com % escapado. */
    busca: z.string().max(80).optional(),
    /** Preço máximo (≥ 0). Compara CAST(meta_value AS DECIMAL(10,2)). */
    preco_max: z.number().nonnegative().optional(),
    /** Só produtos com estoque (stock_status = 'instock'). */
    so_em_estoque: z.boolean().optional(),
    /** 1 .. tetoDeItens. */
    limite: z.number().int().min(1).max(TETO_ITENS_WOOCOMMERCE).optional().default(TETO_ITENS_WOOCOMMERCE),
  })
  .strict();

/** Id do anexo a partir do meta_value (texto) do _thumbnail_id. */
const ANEXO_ID = (alias: string): string => `CAST(${alias}.meta_value AS UNSIGNED)`;

function quotarIdentificadorMysql(nome: string): string {
  return `\`${nome.replace(/`/g, "``")}\``;
}

function escaparLikeMysql(valor: string): string {
  return valor.replace(/!/g, "!!").replace(/%/g, "!%").replace(/_/g, "!_");
}

/** O preço de venda: _price vence; senão _regular_price. Ambas são meta_value (texto). */
const PRECO_COLUNA =
  "COALESCE(NULLIF(CAST(mp.meta_value AS DECIMAL(10,2)), 0), CAST(mrp.meta_value AS DECIMAL(10,2)))";

export const RECEITA_WOOCOMMERCE_PRODUTOS: DefinicaoDeReceita = {
  id: "woocommerce-produtos",
  familia: "woocommerce",
  motores: ["mysql"],
  rotulo: "Produtos da loja WooCommerce",
  descricao:
    "Lê os produtos publicados do WordPress/WooCommerce: título, preço, SKU e estoque. " +
    "O prefixo é o que aparece antes de _posts no banco do WordPress (padrão wp_). " +
    "Devolve também imagem_url (imagem destacada do produto), quando existir. Sem funil nesta fatia.",
  parametrosFixos: PARAMETROS_FIXOS_WOOCOMMERCE,
  parametrosDaBusca: PARAMETROS_DA_BUSCA_WOOCOMMERCE,
  tabelas: (fixos) => {
    const p = (fixos as { prefixo: string }).prefixo ?? PREFIXO_PADRAO;
    return [`${p}posts`, `${p}postmeta`];
  },
  colunas: (fixos) => {
    const p = (fixos as { prefixo: string }).prefixo ?? PREFIXO_PADRAO;
    return {
      // guid/post_type/ID também servem ao anexo da imagem destacada (R4).
      [`${p}posts`]: ["ID", "post_title", "post_status", "post_type", "guid"],
      [`${p}postmeta`]: ["post_id", "meta_key", "meta_value"],
    };
  },
  montar: (fixos, busca, limite) => {
    const p = (fixos as { prefixo: string }).prefixo ?? PREFIXO_PADRAO;
    const posts = quotarIdentificadorMysql(`${p}posts`);
    const postmeta = quotarIdentificadorMysql(`${p}postmeta`);
    const mp = quotarIdentificadorMysql("mp");
    const mrp = quotarIdentificadorMysql("mrp");
    const msku = quotarIdentificadorMysql("msku");
    const mstock = quotarIdentificadorMysql("mstock");
    const mthumb = quotarIdentificadorMysql("mthumb");
    const matt = quotarIdentificadorMysql("matt");

    const valores: unknown[] = [];
    const marcador = (v: unknown): string => {
      valores.push(v === undefined ? null : v);
      return `?`;
    };

    // Monta na ORDEM do texto do SQL: primeiro os JOINs (que aparecem antes
    // do WHERE), depois as cláusulas do WHERE, por fim o LIMIT. Cada chamada a
    // `marcador()` empurra um valor em `valores` exatamente na posição do `?`
    // que gera no texto, então valores nunca saem fora de ordem.
    const joins: string[] = [
      // preço de venda (mp): sempre participa para poder ordenar/filtrar por preço e projetar
      `join ${postmeta} ${mp} on ${mp}.post_id = ${posts}.ID and ${mp}.meta_key = ${marcador("_price")}`,
      // preço regular (mrp): fallback quando _price não existe ou é 0
      `left join ${postmeta} ${mrp} on ${mrp}.post_id = ${posts}.ID and ${mrp}.meta_key = ${marcador("_regular_price")}`,
      // SKU
      `left join ${postmeta} ${msku} on ${msku}.post_id = ${posts}.ID and ${msku}.meta_key = ${marcador("_sku")}`,
      // estoque
      `left join ${postmeta} ${mstock} on ${mstock}.post_id = ${posts}.ID and ${mstock}.meta_key = ${marcador("_stock_status")}`,
      // imagem destacada (R4): postmeta._thumbnail_id -> posts.guid do anexo.
      // LEFT JOIN: produto sem foto continua aparecendo, com imagem_url nulo.
      `left join ${postmeta} ${mthumb} on ${mthumb}.post_id = ${posts}.ID and ${mthumb}.meta_key = ${marcador("_thumbnail_id")}`,
      `left join ${posts} ${matt} on ${matt}.ID = ${ANEXO_ID(mthumb)} and ${matt}.post_type = ${marcador("attachment")}`,
    ];

    const clausulas: string[] = [
      `${posts}.post_type = ${marcador("product")}`,
      `${posts}.post_status = ${marcador("publish")}`,
    ];

    // Busca por título ou SKU: LIKE com % escapado e ESCAPE '!'.
    const buscaStr = (busca as { busca?: string }).busca;
    if (buscaStr) {
      const alvo = `%${escaparLikeMysql(String(buscaStr).toLowerCase().replace(/\s+/g, ""))}%`;
      clausulas.push(
        `(
          replace(lower(cast(${posts}.post_title as char)), ' ', '') like ${marcador(alvo)} escape '!'
          or replace(lower(cast(${msku}.meta_value as char)), ' ', '') like ${marcador(alvo)} escape '!'
        )`,
      );
    }

    const precoMax = (busca as { preco_max?: number }).preco_max;
    if (precoMax !== undefined) {
      clausulas.push(`(${PRECO_COLUNA}) <= ${marcador(precoMax)}`);
    }

    const soEmEstoque = (busca as { so_em_estoque?: boolean }).so_em_estoque;
    if (soEmEstoque) {
      clausulas.push(`${mstock}.meta_value = ${marcador("instock")}`);
    }

    const sql =
      `select ${posts}.ID as id, ` +
      `${posts}.post_title as titulo, ` +
      `${PRECO_COLUNA} as preco, ` +
      `${msku}.meta_value as sku, ` +
      `${mstock}.meta_value as estoque, ` +
      `${posts}.guid as link, ` +
      `${matt}.guid as imagem_url ` +
      `from ${posts} ` +
      `${joins.join(" ")} ` +
      `where ${clausulas.join(" and ")} ` +
      `order by ${posts}.ID ` +
      `limit ${marcador(limite ?? TETO_ITENS_WOOCOMMERCE)}`;

    return { sql, valores };
  },
  tetoDeItens: TETO_ITENS_WOOCOMMERCE,
};
