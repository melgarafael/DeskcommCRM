/**
 * Receita `wordpress-conteudo`: o CONTEÚDO de um site WordPress, uma linha por
 * post publicado, de QUALQUER tipo — imóveis, veículos, cursos, cardápio,
 * eventos.
 *
 * **Por que a receita é genérica (decisão do dono do produto, 21/10/2026).** A
 * receita anterior (`acf-imoveis`) tinha os campos da imobiliária fixos no
 * código (quartos, suítes, vagas…). Um site de veículos, de cursos ou de
 * cardápio guarda os dados do MESMO jeito (tipo de post + `wp_postmeta` +
 * categorias), mas não conseguia usar aquela receita. E uma receita de um
 * nicho só tende a ser EXTENSÃO, não núcleo (`docs/doctrine/extensoes.md`).
 * Então a receita virou o que toda receita de WordPress tem em comum: o
 * administrador diz o tipo de post, quais campos o site guarda e de onde vem
 * cada um.
 *
 * **O que a receita faz:**
 *
 *  - `<prefixo>posts` — post_type = (tipo do admin), post_status = 'publish';
 *  - `<prefixo>postmeta` — uma junção por CAMPO mapeado. **LEFT JOIN**: nenhum
 *    campo é obrigatório, porque um cadastro real não tem o mesmo campo em
 *    todo post (um imóvel só de aluguel não tem preço de venda);
 *  - `<prefixo>terms`, `<prefixo>term_taxonomy`, `<prefixo>term_relationships` —
 *    as CATEGORIAS do site. Entram só quando o administrador mapeou alguma.
 *
 * **O que a receita NÃO faz:** não conhece imóvel, veículo nem curso. O
 * nicho entra pela CONFIGURAÇÃO, que o administrador preenche na tela; o
 * "Imóveis" é só um MODELO que pré-preenche essa configuração (um clique), e
 * vive em `modelos-wordpress.ts` — fora do núcleo da receita.
 *
 * O prefixo entra no SQL SOMENTE via quotar com crase, depois de validado pela
 * regex. Todo valor (meta_key, slug de taxonomia, valor de filtro) vai por
 * placeholder `?`. Nunca concatenação.
 *
 * SEM FOTO nesta fatia (como na R1 e na R2): a receita não traz `imagem_url` e
 * não junciona `_thumbnail_id` nem a tabela de anexos — a foto é a R4.
 */
import { z } from "zod";

import { precoNumero } from "./preco";
import { quotarIdentificadorMysql } from "./sql-mysql";
import {
  alvoDeLike,
  clausulaDeTermo,
  colunasDaTaxonomia,
  subqueryDeTermos,
  tabelasDaTaxonomia,
  type ContextoDeTaxonomia,
  type NivelDaTaxonomia,
} from "./taxonomia";
import { ErroDeFiltroDesconhecido } from "./erros";
import type { DefinicaoDeReceita } from "./tipos";

const PREFIXO_PADRAO = "wp_";
const PREFIXO_REGEX = /^[A-Za-z0-9_]{1,20}$/;
const META_KEY_REGEX = /^[A-Za-z0-9_\-]{1,64}$/;
/** O `taxonomy` do WordPress é `varchar(32)`. */
const TAXONOMIA_REGEX = /^[a-z0-9_-]{1,32}$/;
/** A chave é o nome do dado na saída: só letra, número e underscore. */
const CHAVE_REGEX = /^[a-z][a-z0-9_]{0,31}$/;
/** O tipo de post do WordPress: minúsculas, números, underscore e hífen. */
const POST_TYPE_REGEX = /^[a-z0-9_\-]{1,20}$/;

/** Teto desta fatia: o C2 (custo em tokens de uma resposta de receita) não foi medido. */
export const TETO_ITENS_WORDPRESS_CONTEUDO = 5;

/** Quantos campos o administrador pode mapear numa instância. */
export const MAX_CAMPOS_WORDPRESS = 15;

/** Quantas categorias o administrador pode mapear numa instância. */
export const MAX_CATEGORIAS_WORDPRESS = 6;

/**
 * As chaves que a SAÍDA já usa. O administrador não pode mapear um dado com
 * um destes nomes: a coluna dele colidiria com a do post.
 */
export const CHAVES_RESERVADAS = ["id", "titulo", "link"] as const;

/** O tipo do dado: como o valor é lido e como ele pode ser filtrado. */
export type TipoDeCampo = "texto" | "numero" | "preco";

/** O filtro que o agente pode pedir sobre um campo. */
export type FiltroDeCampo = "nenhum" | "contem" | "igual" | "minimo" | "maximo";

/** O filtro que o agente pode pedir sobre uma categoria. */
export type FiltroDeCategoria = "nenhum" | "contem" | "igual";

/** Um campo do site mapeado (vive em `wp_postmeta`). */
export interface CampoMapeado {
  chave: string;
  rotulo: string;
  meta_key: string;
  tipo: TipoDeCampo;
  filtro: FiltroDeCampo;
}

/** Uma categoria do site mapeada (vive nas três tabelas de termo). */
export interface CategoriaMapeada {
  chave: string;
  rotulo: string;
  taxonomia: string;
  nivel: NivelDaTaxonomia;
  filtro: FiltroDeCategoria;
}

/** O que fica de fora da lista: um campo do site e os valores que somem. */
export interface EsconderMapeado {
  meta_key: string;
  valores: string[];
}

const prefixoSchema = z
  .string()
  .min(1)
  .max(20)
  .regex(PREFIXO_REGEX, "Use apenas letras, números e underscore no prefixo.")
  .default(PREFIXO_PADRAO);

const postTypeSchema = z
  .string()
  .min(1, "Escreva o tipo de post do site.")
  .max(20)
  .regex(
    POST_TYPE_REGEX,
    "Use apenas letras minúsculas, números, underscore e hífen no tipo de post.",
  );

const metaKeySchema = z
  .string()
  .min(1, "Escreva o nome do campo no site.")
  .max(64)
  .regex(
    META_KEY_REGEX,
    "Use apenas letras, números, underscore e hífen no nome do campo.",
  );

const taxonomiaSchema = z
  .string()
  .min(1, "Escreva o nome da categoria no site.")
  .max(32)
  .regex(
    TAXONOMIA_REGEX,
    "Use apenas letras minúsculas, números, underscore e hífen no nome da categoria.",
  );

const chaveSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(
    CHAVE_REGEX,
    "Use apenas letras minúsculas, números e underscore na chave, começando por uma letra.",
  );

const rotuloSchema = z
  .string()
  .trim()
  .min(1, "Escreva um rótulo para o dado.")
  .max(40, "O rótulo pode ter no máximo 40 caracteres.");

/**
 * Um campo mapeado.
 *
 * A compatibilidade entre o TIPO e o FILTRO é regra do Zod, não do SQL: um
 * campo de texto não tem "mínimo" (não é número), e um campo de preço não
 * casa por "contém" (o valor é número, não pedaço de texto).
 */
const campoSchema = z
  .object({
    chave: chaveSchema,
    rotulo: rotuloSchema,
    meta_key: metaKeySchema,
    tipo: z.enum(["texto", "numero", "preco"]),
    filtro: z.enum(["nenhum", "contem", "minimo", "maximo"]),
  })
  .strict()
  .superRefine((campo, ctx) => {
    if (campo.filtro === "contem" && campo.tipo !== "texto") {
      ctx.addIssue({
        code: "custom",
        path: ["filtro"],
        message: "O filtro de conteúdo só vale para um campo de texto.",
      });
    }
    if ((campo.filtro === "minimo" || campo.filtro === "maximo") && campo.tipo === "texto") {
      ctx.addIssue({
        code: "custom",
        path: ["filtro"],
        message: "O filtro de mínimo ou máximo só vale para um campo numérico ou de preço.",
      });
    }
  });

/** Uma categoria mapeada. O nível é a hierarquia do termo (pai/filho). */
const categoriaSchema = z
  .object({
    chave: chaveSchema,
    rotulo: rotuloSchema,
    taxonomia: taxonomiaSchema,
    nivel: z.enum(["qualquer", "filho", "raiz"]).default("qualquer"),
    filtro: z.enum(["nenhum", "contem", "igual"]),
  })
  .strict();

const esconderSchema = z
  .object({
    meta_key: metaKeySchema,
    valores: z
      .array(z.string().min(1).max(60))
      .min(1, "Escreva pelo menos um valor a esconder.")
      .max(10, "Escreva no máximo 10 valores a esconder."),
  })
  .strict();

/** O que o admin preenche na tela: prefixo, tipo de post, campos, categorias e o que esconder. */
export const PARAMETROS_FIXOS_WORDPRESS_CONTEUDO = z
  .object({
    prefixo: prefixoSchema,
    post_type: postTypeSchema,
    campos: z
      .array(campoSchema)
      .min(1, "Mapeie pelo menos um campo do site.")
      .max(MAX_CAMPOS_WORDPRESS, "Mapeie no máximo 15 campos."),
    categorias: z
      .array(categoriaSchema)
      .max(MAX_CATEGORIAS_WORDPRESS, "Mapeie no máximo 6 categorias.")
      .default([]),
    esconder: esconderSchema.optional(),
  })
  .strict()
  .superRefine((fixos, ctx) => {
    // A chave é o nome do dado na saída: ela tem de ser ÚNICA entre campos e
    // categorias, e não pode ser uma das reservadas (id, titulo, link).
    const vistas = new Map<string, "campos" | "categorias">();
    fixos.campos.forEach((campo, i) => {
      if (vistas.has(campo.chave)) {
        ctx.addIssue({
          code: "custom",
          path: ["campos", i, "chave"],
          message: "Cada dado tem uma chave só. Escolha outra chave para um deles.",
        });
      }
      vistas.set(campo.chave, "campos");
      if ((CHAVES_RESERVADAS as readonly string[]).includes(campo.chave)) {
        ctx.addIssue({
          code: "custom",
          path: ["campos", i, "chave"],
          message: "Esta chave é reservada: a saída da consulta já usa esse nome.",
        });
      }
    });
    fixos.categorias.forEach((categoria, i) => {
      if (vistas.has(categoria.chave)) {
        ctx.addIssue({
          code: "custom",
          path: ["categorias", i, "chave"],
          message: "Cada dado tem uma chave só. Escolha outra chave para um deles.",
        });
      }
      vistas.set(categoria.chave, "categorias");
      if ((CHAVES_RESERVADAS as readonly string[]).includes(categoria.chave)) {
        ctx.addIssue({
          code: "custom",
          path: ["categorias", i, "chave"],
          message: "Esta chave é reservada: a saída da consulta já usa esse nome.",
        });
      }
    });
  });

/**
 * O que o agente preenche na conversa.
 *
 * A busca é um DICIONÁRIO de filtros: a chave é o nome do dado (o que a
 * instância mapeou) e o valor é o que se quer. O conjunto de chaves depende da
 * instância, então a validação de cada chave acontece na montagem
 * (`validarFiltrosDaBusca`), contra os fixos gravados.
 */
export const PARAMETROS_DA_BUSCA_WORDPRESS_CONTEUDO = z
  .object({
    filtros: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
    limite: z
      .number()
      .int()
      .min(1)
      .max(TETO_ITENS_WORDPRESS_CONTEUDO)
      .optional()
      .default(TETO_ITENS_WORDPRESS_CONTEUDO),
  })
  .strict();

type BuscaWordpress = z.output<typeof PARAMETROS_DA_BUSCA_WORDPRESS_CONTEUDO>;

/** Os fixos como a receita os lê (o que chegou da tela, já validado pelo Zod). */
interface FixosDaReceita {
  prefixo?: string;
  post_type?: string;
  campos?: CampoMapeado[];
  categorias?: CategoriaMapeada[];
  esconder?: EsconderMapeado;
}

/**
 * A chave gerada a partir do rótulo: sem acento, minúscula e com underscore.
 *
 * É o que permite a tela NÃO pedir a chave a quem opera: ele escreve "Preço
 * de venda" e a chave sai "preco_de_venda". A chave continua editável na
 * tela (a pessoa sabe o que o site chama o dado).
 */
export function chaveDoRotulo(rotulo: string): string {
  const base = rotulo
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
  if (base.length === 0) return "";
  // A chave começa por letra: um rótulo que começa por número ("2024") vira
  // "c_2024".
  return /^[a-z]/.test(base) ? base : `c_${base}`.slice(0, 32);
}

/**
 * Uma chave que ainda não existe entre as outras — para o rótulo repetido
 * não virar o mesmo dado duas vezes.
 *
 * As chaves RESERVADAS (id, titulo, link) contam como já usadas: elas já
 * estão na SAÍDA da consulta, e um dado chamado "Título" viraria `titulo` —
 * a mesma coluna duas vezes. O rótulo "Título" vira `titulo_2`.
 */
export function chaveUnica(base: string, usadas: readonly string[]): string {
  // Um rótulo que não vira chave nenhuma (só símbolos) fica vazio: quem
  // decide o que fazer com isso é a tela, que recusa com frase legível.
  if (base.length === 0) return "";
  const ocupada = (chave: string): boolean =>
    usadas.includes(chave) || (CHAVES_RESERVADAS as readonly string[]).includes(chave);
  if (!ocupada(base)) return base;
  let n = 2;
  while (ocupada(`${base}_${n}`)) n += 1;
  return `${base}_${n}`.slice(0, 32);
}

/** A chave só entra no SQL se casar com a regex — o resto é ignorado. */
function chaveSegura(chave: string): string | undefined {
  return CHAVE_REGEX.test(chave) ? chave : undefined;
}

/** O rótulo do filtro, como o agente lê. */
const ROTULO_DO_FILTRO: Record<Exclude<FiltroDeCampo | FiltroDeCategoria, "nenhum">, string> = {
  contem: "contém",
  minimo: "mínimo",
  maximo: "máximo",
  igual: "igual",
};

/**
 * A descrição dos FILTROS que a instância aceita, derivada dos fixos.
 *
 * É o que o agente precisa para não chutar o nome do filtro: sem esta linha,
 * o agente manda `filtros: { bairro: "centro" }` numa instância de veículos e
 * a consulta volta inteira — ou o agente erra o nome e recebe um erro.
 */
export function descreverFiltrosDaInstancia(fixos: unknown): string {
  const f = (fixos ?? {}) as FixosDaReceita;
  const partes: string[] = [];
  for (const campo of f.campos ?? []) {
    if (campo.filtro === "nenhum") continue;
    partes.push(`${campo.chave} (${campo.rotulo}, ${ROTULO_DO_FILTRO[campo.filtro]})`);
  }
  for (const categoria of f.categorias ?? []) {
    if (categoria.filtro === "nenhum") continue;
    partes.push(`${categoria.chave} (${categoria.rotulo}, ${ROTULO_DO_FILTRO[categoria.filtro]})`);
  }
  if (partes.length === 0) return "filtros disponíveis: nenhum filtro configurado";
  return `filtros disponíveis: ${partes.join("; ")}`;
}

/**
 * A busca bate com o mapeamento da instância?
 *
 * Três recusas, todas com frase legível:
 *  - a chave não existe no mapeamento → o agente inventou o nome;
 *  - a chave existe mas o filtro é "nenhum" → o dado está mapeado, mas não é
 *    filtrável (devolver a lista inteira seria mentir sobre o filtro);
 *  - o valor não é do tipo que o filtro pede → número para mínimo/máximo,
 *    texto para contém/igual.
 */
export function validarFiltrosDaBusca(fixos: unknown, busca: unknown): void {
  const f = (fixos ?? {}) as FixosDaReceita;
  const b = (busca ?? {}) as { filtros?: Record<string, string | number> };
  const filtros = b.filtros;
  if (!filtros) return;

  const disponiveis = new Map<string, { rotulo: string; filtro: string }>();
  for (const campo of f.campos ?? []) disponiveis.set(campo.chave, { rotulo: campo.rotulo, filtro: campo.filtro });
  for (const categoria of f.categorias ?? []) {
    disponiveis.set(categoria.chave, { rotulo: categoria.rotulo, filtro: categoria.filtro });
  }

  for (const [chave, valor] of Object.entries(filtros)) {
    const dado = disponiveis.get(chave);
    if (!dado) {
      throw new ErroDeFiltroDesconhecido(
        chave,
        `O filtro "${chave}" não existe nesta receita. ${descreverFiltrosDaInstancia(fixos)}`,
      );
    }
    if (dado.filtro === "nenhum") {
      throw new ErroDeFiltroDesconhecido(
        chave,
        `O dado "${chave}" (${dado.rotulo}) não pode ser filtrado nesta receita. ${descreverFiltrosDaInstancia(fixos)}`,
      );
    }
    if ((dado.filtro === "minimo" || dado.filtro === "maximo") && typeof valor !== "number") {
      throw new ErroDeFiltroDesconhecido(
        chave,
        `O filtro "${chave}" (${dado.rotulo}) espera um número, e recebeu um texto.`,
      );
    }
    if ((dado.filtro === "contem" || dado.filtro === "igual") && typeof valor !== "string") {
      throw new ErroDeFiltroDesconhecido(
        chave,
        `O filtro "${chave}" (${dado.rotulo}) espera um texto, e recebeu um número.`,
      );
    }
  }
}

/**
 * A comparação numérica de um campo: o `meta_value` é texto, e o filtro de
 * mínimo/máximo compara como número. O PREÇO usa a conversão robusta (o site
 * grava "650.000,00"); os outros números usam CAST.
 */
function comparacaoNumerica(campo: CampoMapeado, alias: string): string {
  if (campo.tipo === "preco") return precoNumero(`${alias}.meta_value`);
  return `CAST(${alias}.meta_value AS DECIMAL(10,2))`;
}

export const RECEITA_WORDPRESS_CONTEUDO: DefinicaoDeReceita = {
  id: "wordpress-conteudo",
  familia: "wordpress",
  motores: ["mysql"],
  rotulo: "Conteúdo do WordPress (qualquer tipo de post)",
  resumo:
    "Qualquer conteúdo de um site WordPress: imóveis, veículos, cursos, eventos, cardápio. O administrador diz o tipo de post e de onde vem cada dado.",
  descricao:
    "Lê o conteúdo publicado de um site WordPress (ACF, ou JetEngine no modo padrão de tipo de post): " +
    "título, os campos que o administrador mapear e o link. " +
    "O administrador diz o tipo de post e de onde vem cada dado: um campo do site (meta_key) ou uma categoria (taxonomia do WordPress). " +
    "Cada dado mapeado pelo administrador pode virar um filtro (contém, mínimo, máximo ou igual). " +
    "Um filtro só prende quando o dado correspondente está mapeado. " +
    "Conteúdo com um valor escondido (por exemplo, vendido) não aparece. Sem foto nesta fatia.",
  parametrosFixos: PARAMETROS_FIXOS_WORDPRESS_CONTEUDO,
  parametrosDaBusca: PARAMETROS_DA_BUSCA_WORDPRESS_CONTEUDO,
  descreverFiltros: descreverFiltrosDaInstancia,
  tabelas: (fixos) => {
    const f = (fixos ?? {}) as FixosDaReceita;
    const p = f.prefixo ?? PREFIXO_PADRAO;
    const base = [`${p}posts`, `${p}postmeta`];
    // As tabelas de categoria só entram quando HÁ categoria mapeada: quem não
    // usa categoria não precisa liberá-las na conexão.
    if ((f.categorias ?? []).length > 0) {
      base.push(...tabelasDaTaxonomia(p));
    }
    return base;
  },
  colunas: (fixos) => {
    const f = (fixos ?? {}) as FixosDaReceita;
    const p = f.prefixo ?? PREFIXO_PADRAO;
    const base: Record<string, string[]> = {
      [`${p}posts`]: ["ID", "post_title", "post_status", "post_type", "guid"],
      [`${p}postmeta`]: ["post_id", "meta_key", "meta_value"],
    };
    if ((f.categorias ?? []).length > 0) {
      Object.assign(base, colunasDaTaxonomia(p));
    }
    return base;
  },
  montar: (fixos, busca, limite) => {
    const f = (fixos ?? {}) as FixosDaReceita;
    const p = f.prefixo ?? PREFIXO_PADRAO;
    const postType = f.post_type ?? "";
    const campos = (f.campos ?? []).filter((c) => chaveSegura(c.chave) !== undefined);
    const categorias = (f.categorias ?? []).filter((c) => chaveSegura(c.chave) !== undefined);
    const esconder = f.esconder;

    // A busca bate com o mapeamento? Se não bater, é ERRO — nunca silêncio.
    // A validação olha os MESMOS campos e categorias que o SQL vai ler: um
    // dado fora da lista não pode "filtrar" nada.
    validarFiltrosDaBusca({ ...f, campos, categorias }, busca);

    const posts = quotarIdentificadorMysql(`${p}posts`);
    const postmeta = quotarIdentificadorMysql(`${p}postmeta`);

    const valores: unknown[] = [];
    const marcador = (v: unknown): string => {
      valores.push(v === undefined ? null : v);
      return `?`;
    };

    const ctx: ContextoDeTaxonomia = { prefixo: p, objeto: "p.ID", marcador };

    /**
     * O apelido da junção de um campo (o nome do campo, com `m` na frente).
     *
     * O apelido é QUOTADO: ele sai da chave que a pessoa digitou (no
     * "avançado" da tela), e identificador não vai cru no SQL. A chave já
     * passa pela regex do Zod — e `chaveSegura` filtra o que escapa.
     */
    const aliasDe = (campo: CampoMapeado): string =>
      quotarIdentificadorMysql(`m${campo.chave}`);

    // ─── 1. A SAÍDA ──────────────────────────────────────────────────────────
    // O SELECT vem PRIMEIRO no texto, então os `?` das categorias saem
    // primeiros na lista de valores. A ordem das colunas é o contrato:
    // id, titulo, cada campo pela chave, cada categoria pela chave, link.
    const colunas: string[] = ["p.ID as id", "p.post_title as titulo"];

    for (const campo of campos) {
      const alias = aliasDe(campo);
      // O PREÇO é lido com a conversão robusta (650.000,00 / 650,000.00 /
      // 480000); os outros campos saem como o site gravou.
      const expressao = campo.tipo === "preco" ? precoNumero(`${alias}.meta_value`) : `${alias}.meta_value`;
      // O apelido da SAÍDA vai QUOTADO: a chave sai do rótulo que a pessoa
      // escreveu, e `key`, `order`, `range` e `rank` são palavras reservadas
      // do MySQL — cru no texto, a consulta não roda.
      colunas.push(`${expressao} as ${quotarIdentificadorMysql(campo.chave)}`);
    }

    for (const categoria of categorias) {
      colunas.push(
        `${subqueryDeTermos(ctx, categoria.taxonomia, categoria.nivel)} as ${quotarIdentificadorMysql(categoria.chave)}`,
      );
    }

    colunas.push("p.guid as link");

    // ─── 2. AS JUNÇÕES ───────────────────────────────────────────────────────
    // Uma LEFT JOIN por campo mapeado. Nenhuma é obrigatória: o LEFT JOIN traz
    // o post mesmo sem o campo (com o valor vazio).
    const juncoes: string[] = [];
    for (const campo of campos) {
      const alias = aliasDe(campo);
      juncoes.push(
        `left join ${postmeta} ${alias} on ${alias}.post_id = p.ID and ${alias}.meta_key = ${marcador(campo.meta_key)}`,
      );
    }

    // ─── 3. ONDE ─────────────────────────────────────────────────────────────
    const clausulas: string[] = [
      `p.post_type = ${marcador(postType)}`,
      `p.post_status = ${marcador("publish")}`,
    ];

    const b = (busca ?? {}) as BuscaWordpress;
    const filtros = b.filtros ?? {};

    // Um filtro por dado mapeado. O que o dado NÃO filtrou não entra no SQL.
    for (const campo of campos) {
      const valor = filtros[campo.chave];
      if (valor === undefined) continue;
      const alias = aliasDe(campo);
      if (campo.filtro === "contem") {
        clausulas.push(`lower(${alias}.meta_value) like ${marcador(alvoDeLike(String(valor)))} escape '!'`);
      } else if (campo.filtro === "minimo") {
        clausulas.push(`(${comparacaoNumerica(campo, alias)}) >= ${marcador(valor)}`);
      } else if (campo.filtro === "maximo") {
        clausulas.push(`(${comparacaoNumerica(campo, alias)}) <= ${marcador(valor)}`);
      }
    }

    for (const categoria of categorias) {
      const valor = filtros[categoria.chave];
      if (valor === undefined) continue;
      // A categoria casa pelo PEDÇO do texto ("contém") ou por IGUALDADE do
      // nome ou do slug ("igual").
      const modo = categoria.filtro === "igual" ? "igualdade" : "contem";
      clausulas.push(
        clausulaDeTermo(ctx, categoria.taxonomia, categoria.nivel, String(valor), modo),
      );
    }

    // O que fica de fora: um `not exists` sobre o campo escondido.
    const aliasEsconder = quotarIdentificadorMysql("mesconder");
    const campoEscondido = esconder?.meta_key?.trim() ?? "";
    const valoresEscondidos = (esconder?.valores ?? [])
      .map((v) => v.trim().toLowerCase())
      .filter((v) => v.length > 0)
      .slice(0, 10);
    if (campoEscondido.length > 0 && valoresEscondidos.length > 0) {
      // A ORDEM dos `?`: o campo vem antes da lista de valores no texto.
      const marcaCampo = marcador(campoEscondido);
      const marcas = valoresEscondidos.map((v) => marcador(v)).join(", ");
      clausulas.push(
        `not exists (select 1 from ${postmeta} ${aliasEsconder} where ${aliasEsconder}.post_id = p.ID ` +
          `and ${aliasEsconder}.meta_key = ${marcaCampo} and lower(${aliasEsconder}.meta_value) in (${marcas}))`,
      );
    }

    // ─── 4. O SQL ────────────────────────────────────────────────────────────
    const sql =
      `select ${colunas.join(", ")} ` +
      `from ${posts} p ` +
      `${juncoes.join(" ")} ` +
      `where ${clausulas.join(" and ")} ` +
      `order by p.ID ` +
      `limit ${marcador(limite ?? TETO_ITENS_WORDPRESS_CONTEUDO)}`;

    return { sql, valores };
  },
  tetoDeItens: TETO_ITENS_WORDPRESS_CONTEUDO,
};
