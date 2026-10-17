/**
 * Receita `tabela-direta`: lê uma tabela PLANA do banco externo, onde cada
 * coluna é um dado (ex.: carros: id, modelo, ano, preco, cor, foto).
 *
 * O admin escolhe a tabela e diz qual coluna é cada dado (id, titulo, preco,
 * filtros_texto, filtro_numero, exibir, status). A saída é sempre id, titulo,
 * preco (se mapeado) e as colunas de exibir com o nome real como apelido.
 *
 * Identificadores (tabela e colunas) entram no SQL SÓ por
 * `quotarIdentificadorMysql`, depois da regex. Valores só por `?`, na ordem
 * do texto.
 *
 * A execução confere que cada coluna usada está nas colunas liberadas da fonte
 * (`colunasLiberadas`). Em modo `all`, confere contra o catálogo real da
 * tabela (a coluna precisa existir), não confia só na regex.
 * Coluna inexistente → erro legível `coluna_inexistente`, nunca erro cru do
 * MySQL.
 *
 * Preço: a coluna pode ser numérica ou texto. Reusa a mesma conversão robusta
 * de `receitas/preco.ts` (4 formatos), aplicada sobre a coluna quotada.
 */
import { z } from "zod";

import { precoNumero } from "./preco";
import { quotarIdentificadorMysql } from "./acf-imoveis";
import type { DefinicaoDeReceita } from "./tipos";

const TABELA_REGEX = /^[A-Za-z0-9_]{1,64}$/;
const COLUNA_REGEX = /^[A-Za-z0-9_]{1,64}$/;
const TABELA_DIRETA_TETO = 5;

const tabelaSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(TABELA_REGEX, "Use apenas letras, números e underline no nome da tabela.");

const colunaSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(COLUNA_REGEX, "Use apenas letras, números e underline no nome da coluna.");

/** Nomes de coluna usados nos fixos não podem se repetir. */
const colunasSchema = z
  .object({
    id: colunaSchema,
    titulo: colunaSchema,
    preco: colunaSchema.optional(),
    /** Até 3 colunas de texto para busca por `texto` (LIKE em OR). */
    filtros_texto: z.array(colunaSchema).min(0).max(3),
    /** Coluna numérica para filtros numero_min/numero_max (ex.: ano). */
    filtro_numero: colunaSchema.optional(),
    /** Coluna com a URL da foto do item (R4); sai como `imagem_url`. */
    imagem: colunaSchema.optional(),
    /** Até 6 colunas adicionais para exibir (apelido = nome real da coluna). */
    exibir: z.array(colunaSchema).min(0).max(6),
    /** Filtro de status fixo: coluna = valor. */
    status: z
      .object({
        coluna: colunaSchema,
        valor: z.string(),
      })
      .optional(),
  })
  .strict()
  .superRefine((colunas, ctx) => {
    const todas: string[] = [
      colunas.id,
      colunas.titulo,
      colunas.preco,
      colunas.imagem,
      ...colunas.filtros_texto,
      colunas.filtro_numero,
      ...colunas.exibir,
      colunas.status?.coluna,
    ].filter((c): c is string => Boolean(c));
    const unicas = new Set(todas);
    if (unicas.size !== todas.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "não repita o mesmo nome de coluna em campos diferentes",
        path: ["colunas"],
      });
    }
    // Coluna de exibir não pode colidir com os apelidos fixos id/titulo/preco.
    for (const exibirColuna of colunas.exibir) {
      if (
        exibirColuna === "id" ||
        exibirColuna === "titulo" ||
        exibirColuna === "preco" ||
        exibirColuna === "imagem_url"
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `a coluna de exibir "${exibirColuna}" colide com o apelido fixo "${exibirColuna}"`,
          path: ["colunas", "exibir"],
        });
      }
    }
  });

/** O que o admin preenche na tela: tabela e mapeamento de colunas por dado. */
export const PARAMETROS_FIXOS_TABELA_DIRETA = z
  .object({
    tabela: tabelaSchema,
    colunas: colunasSchema,
  })
  .strict();

/** O que o agente preenche na conversa. */
export const PARAMETROS_DA_BUSCA_TABELA_DIRETA = z
  .object({
    /** Trecho de texto (até 60). LIKE com escape, case-insensitive, em OR sobre filtros_texto. */
    texto: z.string().max(60).optional(),
    /** Preço máximo (≥ 0) sobre a coluna de preço. */
    preco_max: z.number().nonnegative().optional(),
    /** Preço mínimo (≥ 0) sobre a coluna de preço. */
    preco_min: z.number().nonnegative().optional(),
    /** Valor mínimo (sobre filtro_numero). */
    numero_min: z.number().optional(),
    /** Valor máximo (sobre filtro_numero). */
    numero_max: z.number().optional(),
    /** 1 .. tetoDeItens. */
    limite: z.number().int().min(1).max(TABELA_DIRETA_TETO).optional().default(TABELA_DIRETA_TETO),
  })
  .strict();

function escaparLikeMysql(valor: string): string {
  return valor.replace(/!/g, "!!").replace(/%/g, "!%").replace(/_/g, "!_");
}

/** Mensagem de erro legível quando faltam colunas para um filtro solicitado. */
function erroColunaFaltante(quem: string, coluna: string): Error {
  return new Error(`coluna_inexistente:${quem}: a coluna "${coluna}" não existe ou não foi liberada.`);
}

/** Filtro de texto por coluna, de uso interno (JetEngine): cada entrada vira
 *  lower(col) like ? escape '!' ANDed, valores na ordem do texto. */
type FiltroTextoPorColuna = Record<string, string>;

type TabelaDiretaFixos = {
  tabela: string;
  colunas: {
    id: string;
    titulo: string;
    preco?: string;
    imagem?: string;
    filtros_texto: string[];
    filtro_numero?: string;
    exibir: string[];
    status?: { coluna: string; valor: string };
  };
};

/**
 * Opções internas de montagem (JetEngine). `anexos` = tabela `<prefixo>posts`:
 * quando a coluna de imagem guarda só dígitos, é o ID de um anexo do WordPress
 * e a URL sai do `guid` dele. INFERIDO da documentação do JetEngine (campo de
 * mídia pode guardar URL ou ID); não medido contra instalação real.
 */
export interface OpcoesDeMontagem {
  anexos?: string;
}

type TabelaDiretaBusca = {
  texto?: string;
  preco_min?: number;
  preco_max?: number;
  numero_min?: number;
  numero_max?: number;
  limite?: number;
};

/** Monta o SQL de tabela-direta. Se `extras` for fornecido, cada entrada vira
 *  lower(col) like ? escape '!' ANDed (JetEngine). Senão, usa `busca.texto`
 *  com OR sobre filtros_texto (API pública). */
export function montarTabelaDireta(
  fixos: TabelaDiretaFixos,
  busca: TabelaDiretaBusca,
  limite: number,
  extras?: FiltroTextoPorColuna,
  opcoes?: OpcoesDeMontagem,
): { sql: string; valores: unknown[] } {
  const f = fixos;
  const tabela = f.tabela;
  const c = f.colunas;

  const t = quotarIdentificadorMysql(tabela);
  const colId = quotarIdentificadorMysql(c.id);
  const colTitulo = quotarIdentificadorMysql(c.titulo);
  const colPreco = c.preco ? quotarIdentificadorMysql(c.preco) : null;
  const colFiltroNumero = c.filtro_numero ? quotarIdentificadorMysql(c.filtro_numero) : null;

  const valores: unknown[] = [];
  const marcador = (v: unknown): string => {
    valores.push(v === undefined ? null : v);
    return `?`;
  };

  // Imagem (R4). Com `anexos`, o valor só-dígitos é ID de anexo (JOIN no posts,
  // antes do WHERE, então o valor 'attachment' é o primeiro placeholder).
  let juncaoDeAnexo = "";
  let selecaoDeImagem: string | null = null;
  if (c.imagem) {
    const colImagem = `${t}.${quotarIdentificadorMysql(c.imagem)}`;
    if (opcoes?.anexos) {
      const posts = quotarIdentificadorMysql(opcoes.anexos);
      const matt = quotarIdentificadorMysql("matt");
      const soDigitos = `${colImagem} regexp '^[0-9]+$'`;
      juncaoDeAnexo =
        `left join ${posts} ${matt} on ${matt}.ID = case when ${soDigitos} then cast(${colImagem} as unsigned) else null end ` +
        `and ${matt}.post_type = ${marcador("attachment")} `;
      selecaoDeImagem = `case when ${soDigitos} then ${matt}.guid else ${colImagem} end as imagem_url`;
    } else {
      selecaoDeImagem = `${colImagem} as imagem_url`;
    }
  }

  const clausulas: string[] = [];

  // Status fixo: coluna = valor.
  if (c.status) {
    clausulas.push(`${t}.${quotarIdentificadorMysql(c.status.coluna)} = ${marcador(c.status.valor)}`);
  }

  // Texto: LIKE com escape, case-insensitive.
  // Se `extras` for fornecido (uso interno, JetEngine), cada entrada vira
  // lower(col) like ? escape '!' ANDed, valores na ordem do texto.
  // Senão, usa `texto` com OR sobre filtros_texto (API pública).
  if (extras) {
    for (const [coluna, textoExtra] of Object.entries(extras)) {
      const col = quotarIdentificadorMysql(coluna);
      const alvo = `%${escaparLikeMysql(String(textoExtra).toLowerCase())}%`;
      clausulas.push(`lower(${t}.${col}) like ${marcador(alvo)} escape '!'`);
    }
  } else if (busca.texto) {
    if (c.filtros_texto.length === 0) {
      throw erroColunaFaltante("texto", "filtros_texto");
    }
    const alvo = `%${escaparLikeMysql(String(busca.texto).toLowerCase())}%`;
    const or = c.filtros_texto
      .map((col) => `lower(${t}.${quotarIdentificadorMysql(col)}) like ${marcador(alvo)} escape '!'`)
      .join(" or ");
    clausulas.push(`(${or})`);
  }

  // Preço mínimo e máximo sobre a coluna de preço.
  if (busca.preco_min !== undefined) {
    if (!colPreco) throw erroColunaFaltante("preco_min", "preco");
    clausulas.push(
      `(${precoNumero(`${t}.${colPreco}`)}) >= ${marcador(busca.preco_min)}`,
    );
  }
  if (busca.preco_max !== undefined) {
    if (!colPreco) throw erroColunaFaltante("preco_max", "preco");
    clausulas.push(`(${precoNumero(`${t}.${colPreco}`)}) <= ${marcador(busca.preco_max)}`);
  }

  // Número mínimo e máximo sobre filtro_numero.
  if (busca.numero_min !== undefined) {
    if (!colFiltroNumero) throw erroColunaFaltante("numero_min", "filtro_numero");
    clausulas.push(
      `CAST(${t}.${colFiltroNumero} AS DECIMAL(10,2)) >= ${marcador(busca.numero_min)}`,
    );
  }
  if (busca.numero_max !== undefined) {
    if (!colFiltroNumero) throw erroColunaFaltante("numero_max", "filtro_numero");
    clausulas.push(`CAST(${t}.${colFiltroNumero} AS DECIMAL(10,2)) <= ${marcador(busca.numero_max)}`);
  }

  // Seleção: id, titulo, preco (se mapeado) e exibir com apelido = nome real.
  const camposSelect: string[] = [
    `${t}.${colId} as id`,
    `${t}.${colTitulo} as titulo`,
  ];
  if (colPreco) {
    camposSelect.push(`${precoNumero(`${t}.${colPreco}`)} as preco`);
  }
  if (selecaoDeImagem) camposSelect.push(selecaoDeImagem);
  c.exibir.forEach((col) => {
    camposSelect.push(`${t}.${quotarIdentificadorMysql(col)} as ${quotarIdentificadorMysql(col)}`);
  });

  // Ordenação estável por id.
  const sql =
    `select ${camposSelect.join(", ")} ` +
    `from ${t} ` +
    juncaoDeAnexo +
    (clausulas.length > 0 ? `where ${clausulas.join(" and ")} ` : "") +
    `order by ${t}.${colId} ` +
    `limit ${marcador(limite ?? TABELA_DIRETA_TETO)}`;

  return { sql, valores };
}

export const RECEITA_TABELA_DIRETA: DefinicaoDeReceita = {
  id: "tabela-direta",
  familia: "tabela-direta",
  motores: ["mysql"],
  rotulo: "Tabela direta (qualquer tabela plana)",
  descricao:
    "Lê qualquer tabela plana do banco externo: o admin escolhe a tabela e diz " +
    "qual coluna é cada dado (id, título, preço, imagem, filtros, exibir, status). " +
    "Sem JOIN: uma coluna por dado. Requer que a tabela e as colunas estejam " +
    "liberadas nas fontes da conexão.",
  parametrosFixos: PARAMETROS_FIXOS_TABELA_DIRETA,
  parametrosDaBusca: PARAMETROS_DA_BUSCA_TABELA_DIRETA,
  tabelas: (fixos) => {
    const f = fixos as { tabela: string };
    return [f.tabela];
  },
  colunas: (fixos) => {
    const f = fixos as {
      tabela: string;
      colunas: {
        id: string;
        titulo: string;
        preco?: string;
        imagem?: string;
        filtros_texto: string[];
        filtro_numero?: string;
        exibir: string[];
        status?: { coluna: string; valor: string };
      };
    };
    const c = f.colunas;
    const usadas: string[] = [c.id, c.titulo, c.preco, c.imagem, ...c.filtros_texto, c.filtro_numero, ...c.exibir, c.status?.coluna].filter((x): x is string => Boolean(x));
    return { [f.tabela]: usadas };
  },
  montar: (fixos, busca, limite) => {
    return montarTabelaDireta(fixos as TabelaDiretaFixos, busca as TabelaDiretaBusca, limite);
  },
  tetoDeItens: TABELA_DIRETA_TETO,
};
