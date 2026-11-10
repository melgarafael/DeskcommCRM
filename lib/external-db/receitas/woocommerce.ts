/**
 * Receita `woocommerce-produtos`: JOIN `<prefixo>posts` + `<prefixo>postmeta`
 * do WordPress/WooCommerce, uma linha por produto publicado.
 *
 * O JOIN lê:
 *  - `<prefixo>posts` — post_type = 'product', post_status = 'publish'
 *  - `<prefixo>postmeta` — metas _price, _regular_price, _sku, _stock_status
 *  - `post_excerpt` (resumo) fica na mesma tabela `posts`.
 *
 * Resultado por produto: id, título, preço, SKU, estoque, link (guid).
 *
 * O prefixo entra no SQL SOMENTE via quotar com crase, depois de validado pela
 * regex `^[A-Za-z0-9_]{1,20}$`. Todo valor vai por placeholder `?`.
 * Nunca concatenação.
 */
import { z } from "zod";

import type { DefinicaoDeReceita } from "./tipos";
import { quotarIdentificadorMysql, escaparLikeMysql } from "./sql-mysql";

const PREFIXO_PADRAO = "wp_";
const PREFIXO_REGEX = /^[A-Za-z0-9_]{1,20}$/;

/** Teto desta fatia: o C2 (custo em tokens de uma resposta de receita) não foi medido. */
export const TETO_ITENS_WOOCOMMERCE = 5;

/** Máximo de termos de busca em uma única chamada. */
export const MAX_TERMOS_WOOCOMMERCE = 4;

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

/** Uma palavra de um termo: aceita a forma exata e, se terminar em `s` com mais
 * de 3 letras, também aceita a forma sem o `s` final (camisetas → camiseta). */
const palavraSchema = z.string().trim().min(2).max(60);

/** O que o agente preenche na conversa. Cada termo é UM item que o cliente pediu. */
export const PARAMETROS_DA_BUSCA_WOOCOMMERCE = z
  .object({
    /** Cada termo é um item pedido (ex.: "camiseta", "sorvete"). No singular ou plural. Sem "e"/vírgula dentro do termo. */
    termos: z.array(palavraSchema).min(1).max(MAX_TERMOS_WOOCOMMERCE).optional(),
    /** Preço máximo (≥ 0). Compara CAST(meta_value AS DECIMAL(10,2)). */
    preco_max: z.number().nonnegative().optional(),
    /** Só produtos com estoque (stock_status = 'instock'). */
    so_em_estoque: z.boolean().optional(),
    /** 1 .. tetoDeItens. */
    limite: z.number().int().min(1).max(TETO_ITENS_WOOCOMMERCE).optional().default(TETO_ITENS_WOOCOMMERCE),
    /** Ordem dos resultados. `recentes` traz os IDs maiores primeiro. */
    ordem: z.enum(["antigos", "recentes"]).optional().default("antigos"),
  })
  .strict();

/** O preço de venda: _price vence; senão _regular_price. Ambas são meta_value (texto). */
const PRECO_COLUNA =
  "COALESCE(NULLIF(CAST(mp.meta_value AS DECIMAL(10,2)), 0), CAST(mrp.meta_value AS DECIMAL(10,2)))";

type BuscaWoocommerce = z.output<typeof PARAMETROS_DA_BUSCA_WOOCOMMERCE>;

export const RECEITA_WOOCOMMERCE_PRODUTOS: DefinicaoDeReceita = {
  id: "woocommerce-produtos",
  familia: "woocommerce",
  motores: ["mysql"],
  rotulo: "Produtos da loja WooCommerce",
  resumo: "Os produtos publicados da loja: título, preço, SKU e estoque.",
  descricao:
    "Lê os produtos publicados do WordPress/WooCommerce: título, preço, SKU e estoque. " +
    "O prefixo é o que aparece antes de _posts no banco do WordPress (padrão wp_). " +
    "Para trazer os mais novos primeiro (por exemplo, 'os últimos produtos'), use ordem: \"recentes\"; sem ordem, vêm os mais antigos. " +
    "O cliente pede vários itens? Separe cada um em um termo, no singular ou plural, sem \"e\" nem vírgula dentro do termo " +
    '(ex.: "camisetas e sorvetes" vira termos: ["camiseta", "sorvete"]). ' +
    "Cada termo casa com as palavras dele (em qualquer forma aceita) em título, SKU ou resumo (post_excerpt). " +
    "O teto é o limite vezes o número de termos (até 20). Sem foto e sem funil nesta fatia (R4/R5 ficam para depois). " +
    "Se um termo não trouxer nada, tente um sinônimo numa nova chamada.",
  parametrosFixos: PARAMETROS_FIXOS_WOOCOMMERCE,
  parametrosDaBusca: PARAMETROS_DA_BUSCA_WOOCOMMERCE,
  tabelas: (fixos) => {
    const p = ((fixos ?? {}) as { prefixo?: string }).prefixo ?? PREFIXO_PADRAO;
    return [`${p}posts`, `${p}postmeta`];
  },
  colunas: (fixos) => {
    const p = ((fixos ?? {}) as { prefixo?: string }).prefixo ?? PREFIXO_PADRAO;
    return {
      [`${p}posts`]: ["ID", "post_title", "post_status", "post_type", "guid", "post_excerpt"],
      [`${p}postmeta`]: ["post_id", "meta_key", "meta_value"],
    };
  },
  montar: (fixos, busca, limite) => {
    const p = ((fixos ?? {}) as { prefixo?: string }).prefixo ?? PREFIXO_PADRAO;
    const posts = quotarIdentificadorMysql(`${p}posts`);
    const postmeta = quotarIdentificadorMysql(`${p}postmeta`);
    const mp = quotarIdentificadorMysql("mp");
    const mrp = quotarIdentificadorMysql("mrp");
    const msku = quotarIdentificadorMysql("msku");
    const mstock = quotarIdentificadorMysql("mstock");

    const valores: unknown[] = [];
    const marcador = (v: unknown): string => {
      valores.push(v === undefined ? null : v);
      return `?`;
    };

    const b = busca as BuscaWoocommerce;

    const direcao = b.ordem === "recentes" ? " desc" : "";
    const efetivoLimite = Math.max(1, Math.floor(limite ?? TETO_ITENS_WOOCOMMERCE));

    /** Separa um termo em palavras e devolve as variantes aceitas de cada uma. */
    function variantesDaPalavra(palavra: string): string[] {
      const base = palavra.toLowerCase();
      const variantes = new Set<string>([base]);
      if (base.length > 3 && base.endsWith("s")) {
        variantes.add(base.slice(0, -1));
      }
      return [...variantes];
    }

    /** Uma cláusula que exige TODAS as palavras do termo (em qualquer forma aceita)
     *  em título, SKU ou resumo. Cada palavra gera um bloco de OR (colunas) e as
     *  palavras se combinam com AND. */
    function clausulaDoTermo(termo: string): { sql: string; valores: unknown[] } {
      const palavras = termo.split(/\s+/).filter((w) => w.length > 0);
      const valorLocal: unknown[] = [];
      const marca = (v: unknown): string => {
        valorLocal.push(v === undefined ? null : v);
        return `?`;
      };

      const blocosPorPalavra = palavras.map((palavra) => {
        const variantes = variantesDaPalavra(palavra);
        const ors = variantes.flatMap((variante) => [
          `replace(lower(cast(${posts}.post_title as char)), ' ', '') like ${marca(`%${escaparLikeMysql(variante)}%`)} escape '!'`,
          `replace(lower(cast(${msku}.meta_value as char)), ' ', '') like ${marca(`%${escaparLikeMysql(variante)}%`)} escape '!'`,
          `replace(lower(cast(${posts}.post_excerpt as char)), ' ', '') like ${marca(`%${escaparLikeMysql(variante)}%`)} escape '!'`,
        ]);
        return `(${ors.join(" or ")})`;
      });

      return { sql: blocosPorPalavra.join(" and "), valores: valorLocal };
    }

    /** Monta as 4 joins (preço, preço regular, SKU, estoque), chamando `marcador`
     *  na ordem em que os `?` aparecem no texto. */
    function montarJoins(): string[] {
      return [
        // left join: um produto pode não ter _price (só _regular_price). O JOIN
        // interno tiraria o produto antes do COALESCE da PRECO_COLUNA agir.
        `left join ${postmeta} ${mp} on ${mp}.post_id = ${posts}.ID and ${mp}.meta_key = ${marcador("_price")}`,
        `left join ${postmeta} ${mrp} on ${mrp}.post_id = ${posts}.ID and ${mrp}.meta_key = ${marcador("_regular_price")}`,
        `left join ${postmeta} ${msku} on ${msku}.post_id = ${posts}.ID and ${msku}.meta_key = ${marcador("_sku")}`,
        `left join ${postmeta} ${mstock} on ${mstock}.post_id = ${posts}.ID and ${mstock}.meta_key = ${marcador("_stock_status")}`,
      ];
    }

    /** Monta as cláusulas base do WHERE (post_type, post_status, [preço], [estoque]),
     *  chamando `marcador` na ordem em que os `?` aparecem no texto. */
    function montarBase(): string[] {
      const base: string[] = [
        `${posts}.post_type = ${marcador("product")}`,
        `${posts}.post_status = ${marcador("publish")}`,
      ];
      const precoMax = b.preco_max;
      if (precoMax !== undefined) {
        // PRECO_COLUNA vira NULL quando o produto não tem _price nem _regular_price.
        // No MySQL `NULL <= x` é falso (desconhecido), então produto sem preço
        // nenhum nunca passa no filtro de preço máximo — mesmo com left join.
        base.push(`(${PRECO_COLUNA}) <= ${marcador(precoMax)}`);
      }
      const soEmEstoque = b.so_em_estoque;
      if (soEmEstoque) {
        base.push(`${mstock}.meta_value = ${marcador("instock")}`);
      }
      return base;
    }

    const termos = b.termos;

    if (termos && termos.length > 0) {
      // Um bloco por termo, cada um com o seu limite. UNION ALL entre eles.
      //
      // Ordem dos `?` no texto de cada sub-select:
      // 1. termo (coluna `termo` no select)
      // 2-5. joins (4 meta_key)
      // 6-N. base (post_type, post_status, [preco_max], [so_em_estoque])
      // N+1..N+3. busca (cada palavra: or sobre título/SKU/resumo)
      // último. limite interno
      // Chamar `marcador` nesta mesma ordem para que `valores` alinhe com os `?`.
      const blocos: string[] = [];
      for (const termo of termos) {
        const termoPos = marcador(termo); // 1
        const joins = montarJoins(); // 2-5
        const base = montarBase(); // 6-N
        const clausula = clausulaDoTermo(termo);
        clausula.valores.forEach((v) => valores.push(v)); // busca (N+1..N+3)
        const limiteInterno = marcador(efetivoLimite); // último
        blocos.push(
          `(
            select ${posts}.ID as id, ${posts}.post_title as titulo, ${PRECO_COLUNA} as preco, ${msku}.meta_value as sku, ${mstock}.meta_value as estoque, ${posts}.guid as link, ${termoPos} as termo
            from ${posts}
            ${joins.join(" ")}
            where ${base.join(" and ")} and ${clausula.sql}
            order by ${posts}.ID${direcao}
            limit ${limiteInterno}
          )`,
        );
      }

      const limiteTotal = marcador(efetivoLimite * termos.length);
      const sql =
        `select * from (${blocos.join(" union all ")}) as t order by t.id${direcao} limit ${limiteTotal}`;

      return { sql, valores };
    }

    // Sem termos: um bloco só, como antes (lista geral com ordem).
    const joins = montarJoins();
    const base = montarBase();
    const sql =
      `select ${posts}.ID as id, ` +
      `${posts}.post_title as titulo, ` +
      `${PRECO_COLUNA} as preco, ` +
      `${msku}.meta_value as sku, ` +
      `${mstock}.meta_value as estoque, ` +
      `${posts}.guid as link ` +
      `from ${posts} ` +
      `${joins.join(" ")} ` +
      `where ${base.join(" and ")} ` +
      `order by ${posts}.ID${direcao} ` +
      `limit ${marcador(efetivoLimite)}`;

    return { sql, valores };
  },
  tetoDeItens: TETO_ITENS_WOOCOMMERCE,
};
