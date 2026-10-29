/**
 * Receita `tabela-direta`: lê uma TABELA PLANA do banco externo, uma linha por
 * item, uma coluna por dado. O administrador diz a tabela, a coluna do id, a
 * do título, e mapeia cada dado (rótulo → coluna, tipo, filtro).
 *
 * **Por que é genérica.** Não conhece imóvel, veículo nem curso. O nicho entra
 * pela configuração que o admin preenche na tela — o "JetEngine CCT" é um
 * MODELO que pré-preenche essa configuração (um clique), e vive em
 * `modelos-tabela-direta.ts` — fora do núcleo da receita.
 *
 * **O que a receita faz:**
 *  - `<tabela>` — lê a tabela informada pelo admin;
 *  - `<colunaId>` → `id`, `<colunaTitulo>` → `titulo`;
 *  - cada campo mapeado → sua coluna, na saída, pela chave;
 *  - opcional: `só mostrar quando <coluna> = <valor>` (ex.: `cct_status = publish`);
 *  - opcional: `esconder quando <coluna> in <valores>` (ex.: situação vendido).
 *
 * **O que a receita NÃO faz:** sem JOIN, sem taxonomia, sem categoria, sem foto
 * (é a R4). Todo valor entra por placeholder `?`; identificadores (tabela,
 * colunas, apelidos de saída) vão quotados com crase, depois de validados por
 * regex. Nunca concatenação.
 */
import { z } from "zod";

import { precoNumero } from "./preco";
import { quotarIdentificadorMysql } from "./sql-mysql";
import { alvoDeLike } from "./taxonomia";
import { ErroDeFiltroDesconhecido } from "./erros";
import type { DefinicaoDeReceita } from "./tipos";

const TABELA_REGEX = /^[A-Za-z0-9_]{1,64}$/;
const COLUNA_REGEX = /^[A-Za-z0-9_]{1,64}$/;

/** Teto desta fatia: o C2 (custo em tokens de uma resposta de receita) não foi medido. */
export const TETO_ITENS_TABELA_DIRETA = 5;

/** Quantos campos o administrador pode mapear numa instância. */
export const MAX_CAMPOS_TABELA_DIRETA = 15;

/**
 * As chaves que a SAÍDA já usa. O administrador não pode mapear um dado com
 * um destes nomes: a coluna dele colidiria com a do post.
 */
export const CHAVES_RESERVADAS_TABELA_DIRETA = ["id", "titulo", "link"] as const;

/** Um campo da tabela mapeado (uma coluna → um dado na saída). */
export interface CampoMapeadoTabelaDireta {
  chave: string;
  rotulo: string;
  coluna: string;
  tipo: TipoDeCampoTabelaDireta;
  filtro: FiltroDeCampoTabelaDireta;
}

/** O que fica de fora da lista: uma coluna e os valores que somem. */
export interface EsconderQuandoTabelaDireta {
  coluna: string;
  valores: string[];
}

/** A regra "só mostrar quando": uma coluna deve igualar um valor. */
export interface SoMostrarQuandoTabelaDireta {
  coluna: string;
  valor: string;
}

/** O que o admin preenche na tela: tabela, coluna do id, coluna do título, campos e regras de exclusão/inclusão. */
const colunaSchema = z
  .string()
  .min(1, "Escreva o nome da coluna na tabela.")
  .max(64)
  .regex(
    COLUNA_REGEX,
    "Use apenas letras, números e underscore no nome da coluna.",
  );

const tabelaSchema = z
  .string()
  .min(1, "Escreva o nome da tabela no banco.")
  .max(64)
  .regex(
    TABELA_REGEX,
    "Use apenas letras, números e underscore no nome da tabela.",
  );

const campoSchema = z
  .object({
    chave: z
      .string()
      .min(1)
      .max(32)
      .regex(
        /^[a-z][a-z0-9_]{0,31}$/,
        "Use apenas letras minúsculas, números e underscore na chave, começando por uma letra.",
      ),
    rotulo: z
      .string()
      .trim()
      .min(1, "Escreva um rótulo para o dado.")
      .max(40, "O rótulo pode ter no máximo 40 caracteres."),
    coluna: colunaSchema,
    tipo: z.enum(["texto", "numero", "preco"]),
    filtro: z.enum(["nenhum", "contem", "igual", "minimo", "maximo"]),
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

const soMostrarQuandoSchema = z
  .object({
    coluna: colunaSchema,
    valor: z.string().min(1, "Escreva o valor que deve aparecer."),
  })
  .strict();

const esconderQuandoSchema = z
  .object({
    coluna: colunaSchema,
    valores: z
      .array(z.string().min(1).max(60))
      .min(1, "Escreva pelo menos um valor a esconder.")
      .max(10, "Escreva no máximo 10 valores a esconder."),
  })
  .strict();

/** O que o admin preenche na tela. */
export const PARAMETROS_FIXOS_TABELA_DIRETA = z
  .object({
    tabela: tabelaSchema,
    coluna_id: colunaSchema,
    coluna_titulo: colunaSchema,
    campos: z
      .array(campoSchema)
      .min(1, "Mapeie pelo menos um dado da tabela.")
      .max(MAX_CAMPOS_TABELA_DIRETA, "Mapeie no máximo 15 dados."),
    so_mostrar_quando: soMostrarQuandoSchema.optional(),
    esconder_quando: esconderQuandoSchema.optional(),
  })
  .strict()
  .superRefine((fixos, ctx) => {
    // A chave é o nome do dado na saída: ela tem de ser ÚNICA entre os campos e
    // não pode ser uma das reservadas (id, titulo, link).
    const vistas = new Set<string>();
    fixos.campos.forEach((campo, i) => {
      if (vistas.has(campo.chave)) {
        ctx.addIssue({
          code: "custom",
          path: ["campos", i, "chave"],
          message: "Cada dado tem uma chave só. Escolha outra chave para um deles.",
        });
      }
      vistas.add(campo.chave);
      if ((CHAVES_RESERVADAS_TABELA_DIRETA as readonly string[]).includes(campo.chave)) {
        ctx.addIssue({
          code: "custom",
          path: ["campos", i, "chave"],
          message: "Esta chave é reservada: a saída da consulta já usa esse nome.",
        });
      }
    });
  });

/** O que o agente preenche na conversa. */
export const PARAMETROS_DA_BUSCA_TABELA_DIRETA = z
  .object({
    filtros: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
    limite: z
      .number()
      .int()
      .min(1)
      .max(TETO_ITENS_TABELA_DIRETA)
      .optional()
      .default(TETO_ITENS_TABELA_DIRETA),
  })
  .strict();

type BuscaTabelaDireta = z.output<typeof PARAMETROS_DA_BUSCA_TABELA_DIRETA>;

/** Os fixos como a receita os lê (o que chegou da tela/banco, já validado pelo Zod). */
interface FixosDaReceita {
  tabela?: string;
  coluna_id?: string;
  coluna_titulo?: string;
  campos?: CampoMapeadoTabelaDireta[];
  so_mostrar_quando?: SoMostrarQuandoTabelaDireta;
  esconder_quando?: EsconderQuandoTabelaDireta;
}

/**
 * A descrição dos FILTROS que a instância aceita, derivada dos fixos.
 *
 * É o que o agente precisa para não chutar o nome do filtro.
 */
export function descreverFiltrosDaInstanciaTabelaDireta(fixos: unknown): string {
  const f = (fixos ?? {}) as FixosDaReceita;
  const partes: string[] = [];
  for (const campo of f.campos ?? []) {
    if (campo.filtro === "nenhum") continue;
    partes.push(`${campo.chave} (${campo.rotulo}, ${campo.filtro})`);
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
 *    filtrável;
 *  - o valor não é do tipo que o filtro pede → número para mínimo/máximo,
 *    texto para contém/igual.
 */
export function validarFiltrosDaBuscaTabelaDireta(fixos: unknown, busca: unknown): void {
  const f = (fixos ?? {}) as FixosDaReceita;
  const b = (busca ?? {}) as { filtros?: Record<string, string | number> };
  const filtros = b.filtros;
  if (!filtros) return;

  const disponiveis = new Map<string, { rotulo: string; filtro: string }>();
  for (const campo of f.campos ?? []) disponiveis.set(campo.chave, { rotulo: campo.rotulo, filtro: campo.filtro });

  for (const [chave, valor] of Object.entries(filtros)) {
    const dado = disponiveis.get(chave);
    if (!dado) {
      throw new ErroDeFiltroDesconhecido(
        chave,
        `O filtro "${chave}" não existe nesta receita. ${descreverFiltrosDaInstanciaTabelaDireta(fixos)}`,
      );
    }
    if (dado.filtro === "nenhum") {
      throw new ErroDeFiltroDesconhecido(
        chave,
        `O dado "${chave}" (${dado.rotulo}) não pode ser filtrado nesta receita. ${descreverFiltrosDaInstanciaTabelaDireta(fixos)}`,
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

/** O tipo do dado: como o valor é lido e como ele pode ser filtrado. */
export type TipoDeCampoTabelaDireta = "texto" | "numero" | "preco";

/** O filtro que o agente pode pedir sobre um campo. */
export type FiltroDeCampoTabelaDireta = "nenhum" | "contem" | "igual" | "minimo" | "maximo";

/**
 * A comparação numérica de um campo: o valor é texto, e o filtro de
 * mínimo/máximo compara como número. O PREÇO usa a conversão robusta
 * (o site grava "650.000,00"); os outros números usam CAST.
 */
function comparacaoNumerica(campo: CampoMapeadoTabelaDireta, alias: string): string {
  if (campo.tipo === "preco") {
    return precoNumero(`${alias}.${quotarIdentificadorMysql(campo.coluna)}`);
  }
  return `CAST(${alias}.${quotarIdentificadorMysql(campo.coluna)} AS DECIMAL(10,2))`;
}

export const RECEITA_TABELA_DIRETA: DefinicaoDeReceita = {
  id: "tabela-direta",
  familia: "tabela-direta",
  motores: ["mysql"],
  rotulo: "Tabela direta (qualquer tabela plana)",
  resumo:
    "Qualquer tabela plana do banco externo: uma linha por item, uma coluna por dado. O administrador diz a tabela, a coluna do id e a do título, e mapeia cada dado.",
  descricao:
    "Lê uma tabela plana do banco de origem: o id, o título e os campos que o administrador mapear. " +
    "O administrador diz a tabela, a coluna do id e a do título, e mapeia cada coluna como um dado (texto, número ou preço). " +
    "Cada dado mapeado pelo administrador pode virar um filtro (contém, mínimo, máximo ou igual). " +
    "Pode restringir a 'só mostrar quando <coluna> = <valor>' e a 'esconder quando <coluna> in <valores>'. " +
    "Um filtro só prende quando o dado correspondente está mapeado. Sem JOIN, sem taxonomia, sem foto nesta fatia.",
  parametrosFixos: PARAMETROS_FIXOS_TABELA_DIRETA,
  parametrosDaBusca: PARAMETROS_DA_BUSCA_TABELA_DIRETA,
  descreverFiltros: descreverFiltrosDaInstanciaTabelaDireta,
  tabelas: (fixos) => {
    const f = (fixos ?? {}) as FixosDaReceita;
    return [f.tabela ?? ""];
  },
  colunas: (fixos) => {
    const f = (fixos ?? {}) as FixosDaReceita;
    const colunas: string[] = [f.coluna_id ?? "", f.coluna_titulo ?? ""];
    for (const campo of f.campos ?? []) colunas.push(campo.coluna);
    if (f.so_mostrar_quando?.coluna) colunas.push(f.so_mostrar_quando.coluna);
    if (f.esconder_quando?.coluna) colunas.push(f.esconder_quando.coluna);
    return { [f.tabela ?? ""]: colunas };
  },
  montar: (fixos, busca, limite) => {
    const f = (fixos ?? {}) as FixosDaReceita;
    const tabela = quotarIdentificadorMysql(f.tabela ?? "");
    const colunaId = quotarIdentificadorMysql(f.coluna_id ?? "");
    const colunaTitulo = quotarIdentificadorMysql(f.coluna_titulo ?? "");
    const campos = (f.campos ?? []).filter((c) => /^[a-z][a-z0-9_]{0,31}$/.test(c.chave));
    const soMostrar = f.so_mostrar_quando;
    const esconder = f.esconder_quando;

    // A busca bate com o mapeamento? Se não bater, é ERRO — nunca silêncio.
    validarFiltrosDaBuscaTabelaDireta({ ...f }, busca);

    const valores: unknown[] = [];
    const marcador = (v: unknown): string => {
      valores.push(v === undefined ? null : v);
      return `?`;
    };

    // ─── 1. A SAÍDA ──────────────────────────────────────────────────────────
    // O contrato: id, título, cada campo mapeado pela chave.
    const colunas: string[] = [`${colunaId} as id`, `${colunaTitulo} as titulo`];

    for (const campo of campos) {
      // O PREÇO é lido com a conversão robusta; os outros campos saem como o banco gravou.
      const expressao =
        campo.tipo === "preco"
          ? precoNumero(`t.${quotarIdentificadorMysql(campo.coluna)}`)
          : `t.${quotarIdentificadorMysql(campo.coluna)}`;
      colunas.push(`${expressao} as ${quotarIdentificadorMysql(campo.chave)}`);
    }

    // ─── 2. AS JUNÇÕES ───────────────────────────────────────────────────────
    // Não há JOIN: a receita lê uma única tabela plana.
    const juncoes: string[] = [];

    // ─── 3. ONDE ─────────────────────────────────────────────────────────────
    const clausulas: string[] = [];

    // Só mostrar quando a coluna é igual ao valor.
    if (soMostrar?.coluna?.trim() && soMostrar.valor.trim().length > 0) {
      clausulas.push(
        `${quotarIdentificadorMysql(soMostrar.coluna.trim())} = ${marcador(soMostrar.valor.trim())}`,
      );
    }

    // Esconder quando a coluna está entre os valores.
    if (esconder?.coluna?.trim() && esconder.valores.length > 0) {
      const valoresEscondidos = esconder.valores
        .map((v) => v.trim())
        .filter((v) => v.length > 0)
        .slice(0, 10);
      if (valoresEscondidos.length > 0) {
        const marcas = valoresEscondidos.map((v) => marcador(v)).join(", ");
        const coluna = quotarIdentificadorMysql(esconder.coluna.trim());
        // `NULL not in (...)` é NULL, não verdadeiro: sem o `is null`, o item
        // sem situação preenchida sumiria junto com os escondidos.
        clausulas.push(`(${coluna} is null or ${coluna} not in (${marcas}))`);
      }
    }

    // Filtros do agente sobre os campos mapeados.
    const b = (busca ?? {}) as BuscaTabelaDireta;
    const filtros = b.filtros ?? {};
    for (const campo of campos) {
      const valor = filtros[campo.chave];
      if (valor === undefined) continue;
      if (campo.filtro === "contem") {
        clausulas.push(
          `lower(t.${quotarIdentificadorMysql(campo.coluna)}) like ${marcador(alvoDeLike(String(valor)))} escape '!'`,
        );
      } else if (campo.filtro === "igual") {
        clausulas.push(
          `t.${quotarIdentificadorMysql(campo.coluna)} = ${marcador(String(valor))}`,
        );
      } else if (campo.filtro === "minimo") {
        clausulas.push(`(${comparacaoNumerica(campo, "t")}) >= ${marcador(valor)}`);
      } else if (campo.filtro === "maximo") {
        clausulas.push(`(${comparacaoNumerica(campo, "t")}) <= ${marcador(valor)}`);
      }
    }

    // ─── 4. O SQL ────────────────────────────────────────────────────────────
    // Cada parte só entra quando tem texto, e sem espaço nas pontas: com a
    // montagem intercalada de pedaços, sem junções nem filtros entrava um
    // pedaço vazio entre espaços e saía "t  order by" com espaço duplo.
    const where = clausulas.length > 0 ? `where ${clausulas.join(" and ")}` : "";
    const sql = [
      `select ${colunas.join(", ")}`,
      `from ${tabela} t`,
      ...juncoes,
      where,
      `order by ${colunaId}`,
      `limit ${marcador(limite ?? TETO_ITENS_TABELA_DIRETA)}`,
    ]
      .filter(Boolean)
      .join(" ");

    return { sql, valores };
  },
  tetoDeItens: TETO_ITENS_TABELA_DIRETA,
};
