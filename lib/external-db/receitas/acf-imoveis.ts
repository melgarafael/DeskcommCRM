/**
 * Receita `acf-imoveis`: JOIN `<prefixo>posts` + `<prefixo>postmeta`
 * do WordPress com ACF, uma linha por imóvel publicado.
 *
 * O JOIN lê:
 *  - `<prefixo>posts` — post_type = (tipo do admin), post_status = 'publish'
 *  - `<prefixo>postmeta` — uma junção por campo mapeado (preco, quartos,
 *    bairro e opcionalmente cidade, area, finalidade)
 *
 * O prefixo entra no SQL SOMENTE via quotar com crase, depois de validado pela
 * regex. Todo valor (meta_key, post_type, filtros) vai por placeholder `?`.
 * Nunca concatenação.
 *
 * Limitação declarada (Spec 25 D2/C1): bairro vem de campo ACF (meta_key).
 * Taxonomia (wp_terms / wp_term_taxonomy / wp_term_relationships) fica para
 * uma fatia seguinte — não há junção a taxonomia nesta receita.
 */
import { z } from "zod";

import { precoNumero } from "./preco";
import type { DefinicaoDeReceita } from "./tipos";

const PREFIXO_PADRAO = "wp_";
const PREFIXO_REGEX = /^[A-Za-z0-9_]{1,20}$/;
const POST_TYPE_REGEX = /^[a-z0-9_\-]{1,20}$/;
const META_KEY_REGEX = /^[A-Za-z0-9_\-]{1,64}$/;
const POST_TYPE_PADRAO = "imovel";

/** Teto desta fatia: o C2 (custo em tokens de uma resposta de receita) não foi medido. */
export const TETO_ITENS_ACF_IMOVEIS = 5;

export const prefixoSchema = z
  .string()
  .min(1)
  .max(20)
  .regex(PREFIXO_REGEX, "Use apenas letras, números e underline no prefixo.")
  .default(PREFIXO_PADRAO);

export const postTypeSchema = z
  .string()
  .min(1)
  .max(20)
  .regex(
    POST_TYPE_REGEX,
    "Use apenas letras minúsculas, números, underline e hífen no tipo de post.",
  )
  .default(POST_TYPE_PADRAO);

export function quotarIdentificadorMysql(nome: string): string {
  return `\`${nome.replace(/`/g, "``")}\``;
}

const metaKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    META_KEY_REGEX,
    "Use apenas letras, números, underline e hífen na chave de campo (meta_key).",
  );

/** O que o admin preenche na tela: prefixo, tipo de post e mapeamento de meta_key por dado. */
export const PARAMETROS_FIXOS_ACF_IMOVEIS = z
  .object({
    prefixo: prefixoSchema,
    post_type: postTypeSchema,
    campos: z
      .object({
        preco: metaKeySchema,
        quartos: metaKeySchema,
        bairro: metaKeySchema,
        cidade: metaKeySchema.optional(),
        area: metaKeySchema.optional(),
        finalidade: metaKeySchema.optional(),
      })
      .strict(),
  })
  .strict();

/** O que o agente preenche na conversa. */
export const PARAMETROS_DA_BUSCA_ACF_IMOVEIS = z
  .object({
    /** Bairro (até 60 chars). LIKE com escape, sem diferenciar maiúsculas e minúsculas. */
    bairro: z.string().max(60).optional(),
    /** Quartos mínimos (0..20). */
    quartos_min: z.number().int().min(0).max(20).optional(),
    /** Preço máximo (≥ 0). O meta_value pode vir "650.000,00" ou "480000". */
    preco_max: z.number().nonnegative().optional(),
    /** Cidade (só se o campo cidade estiver mapeado). */
    cidade: z.string().max(60).optional(),
    /** 1 .. tetoDeItens. */
    limite: z
      .number()
      .int()
      .min(1)
      .max(TETO_ITENS_ACF_IMOVEIS)
      .optional()
      .default(TETO_ITENS_ACF_IMOVEIS),
  })
  .strict();

function escaparLikeMysql(valor: string): string {
  return valor.replace(/!/g, "!!").replace(/%/g, "!%").replace(/_/g, "!_");
}

export const RECEITA_ACF_IMOVEIS: DefinicaoDeReceita = {
  id: "acf-imoveis",
  familia: "acf-imoveis",
  motores: ["mysql"],
  rotulo: "Imóveis do WordPress com ACF",
  descricao:
    "Lê os imóveis publicados de um WordPress com ACF: título, preço, quartos, bairro " +
    "e (opcional) cidade, área e finalidade. O admin informa o tipo de post e qual meta_key " +
    "é cada campo. Devolve também imagem_url (imagem destacada), quando existir. Sem taxonomia nesta fatia (bairro por campo ACF; taxonomia fica para depois).",
  parametrosFixos: PARAMETROS_FIXOS_ACF_IMOVEIS,
  parametrosDaBusca: PARAMETROS_DA_BUSCA_ACF_IMOVEIS,
  tabelas: (fixos) => {
    const p = (fixos as { prefixo: string }).prefixo ?? PREFIXO_PADRAO;
    return [`${p}posts`, `${p}postmeta`];
  },
  colunas: (fixos) => {
    const p = (fixos as { prefixo: string }).prefixo ?? PREFIXO_PADRAO;
    return {
      [`${p}posts`]: ["ID", "post_title", "post_status", "post_type", "guid"],
      [`${p}postmeta`]: ["post_id", "meta_key", "meta_value"],
    };
  },
  montar: (fixos, busca, limite) => {
    const p =
      (fixos as { prefixo: string; post_type: string; campos: unknown }).prefixo ?? PREFIXO_PADRAO;
    const postType = (fixos as { post_type?: string }).post_type ?? POST_TYPE_PADRAO;
    const campos =
      (
        fixos as {
          campos?: {
            preco?: string;
            quartos?: string;
            bairro?: string;
            cidade?: string;
            area?: string;
            finalidade?: string;
          };
        }
      ).campos ?? {};

    const posts = quotarIdentificadorMysql(`${p}posts`);
    const postmeta = quotarIdentificadorMysql(`${p}postmeta`);

    const valores: unknown[] = [];
    const marcador = (v: unknown): string => {
      valores.push(v === undefined ? null : v);
      return `?`;
    };

    // Junções: uma por campo mapeado. Obrigatórias (preco, quartos, bairro) = JOIN;
    // opcionais (cidade, area, finalidade) = LEFT JOIN. Ordem do texto do SQL.
    const juncoes: string[] = [];
    const aliases: Record<string, string> = {};

    const adicionarJuncao = (nomeCampo: string, metaKey: string, tipo: "join" | "left join") => {
      const alias = `m${nomeCampo}`;
      aliases[nomeCampo] = alias;
      juncoes.push(
        `${tipo} ${postmeta} ${alias} on ${alias}.post_id = ${posts}.ID and ${alias}.meta_key = ${marcador(metaKey)}`,
      );
    };

    // Obrigatórias (sempre presentes nos fixos validados pelo Zod).
    adicionarJuncao("preco", campos.preco ?? "", "join");
    adicionarJuncao("quartos", campos.quartos ?? "", "join");
    adicionarJuncao("bairro", campos.bairro ?? "", "join");

    // Opcionais — só entram se o admin mapeou.
    if (campos.cidade) adicionarJuncao("cidade", campos.cidade, "left join");
    if (campos.area) adicionarJuncao("area", campos.area, "left join");
    if (campos.finalidade) adicionarJuncao("finalidade", campos.finalidade, "left join");

    // Imagem destacada (R4): postmeta._thumbnail_id -> posts.guid do anexo.
    // LEFT JOIN: imóvel sem foto continua aparecendo, com imagem_url nulo.
    const thumb = quotarIdentificadorMysql("mthumb");
    const anexo = quotarIdentificadorMysql("matt");
    juncoes.push(
      `left join ${postmeta} ${thumb} on ${thumb}.post_id = ${posts}.ID and ${thumb}.meta_key = ${marcador("_thumbnail_id")}`,
      `left join ${posts} ${anexo} on ${anexo}.ID = CAST(${thumb}.meta_value AS UNSIGNED) and ${anexo}.post_type = ${marcador("attachment")}`,
    );

    const clausulas: string[] = [
      `${posts}.post_type = ${marcador(postType)}`,
      `${posts}.post_status = ${marcador("publish")}`,
    ];

    // Bairro: LIKE com escape, case-insensitive (LOWER dos dois lados).
    const bairroStr = (busca as { bairro?: string }).bairro;
    if (bairroStr) {
      const alvo = `%${escaparLikeMysql(String(bairroStr).toLowerCase())}%`;
      clausulas.push(`lower(${aliases.bairro}.meta_value) like ${marcador(alvo)} escape '!'`);
    }

    // Quartos mínimos: CAST do meta_value para número.
    const quartosMin = (busca as { quartos_min?: number }).quartos_min;
    if (quartosMin !== undefined) {
      clausulas.push(
        `CAST(${aliases.quartos}.meta_value AS DECIMAL(10,2)) >= ${marcador(quartosMin)}`,
      );
    }

    // Preço máximo: conversão robusta de "650.000,00" / "480000" para número.
    const precoMax = (busca as { preco_max?: number }).preco_max;
    if (precoMax !== undefined) {
      clausulas.push(
        `(${precoNumero(`${aliases.preco}.meta_value`)}) <= ${marcador(precoMax)}`,
      );
    }

    // Cidade: igual ao bairro, LIKE case-insensitive.
    const cidadeStr = (busca as { cidade?: string }).cidade;
    if (cidadeStr && aliases.cidade) {
      const alvo = `%${escaparLikeMysql(String(cidadeStr).toLowerCase())}%`;
      clausulas.push(`lower(${aliases.cidade}.meta_value) like ${marcador(alvo)} escape '!'`);
    }

    const colunaPreco = `${aliases.preco}.meta_value`;
    const camposSelect = [
      `${posts}.ID as id`,
      `${posts}.post_title as titulo`,
      `${precoNumero(colunaPreco)} as preco`,
      `${aliases.quartos}.meta_value as quartos`,
      `${aliases.bairro}.meta_value as bairro`,
    ];
    if (aliases.cidade) camposSelect.push(`${aliases.cidade}.meta_value as cidade`);
    if (aliases.area) camposSelect.push(`${aliases.area}.meta_value as area`);
    if (aliases.finalidade) camposSelect.push(`${aliases.finalidade}.meta_value as finalidade`);
    camposSelect.push(`${posts}.guid as link`);
    camposSelect.push(`${anexo}.guid as imagem_url`);

    const sql =
      `select ${camposSelect.join(", ")} ` +
      `from ${posts} ` +
      `${juncoes.join(" ")} ` +
      `where ${clausulas.join(" and ")} ` +
      `order by ${posts}.ID ` +
      `limit ${marcador(limite ?? TETO_ITENS_ACF_IMOVEIS)}`;

    return { sql, valores };
  },
  tetoDeItens: TETO_ITENS_ACF_IMOVEIS,
};
