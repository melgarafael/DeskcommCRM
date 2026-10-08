/**
 * Montagem do SELECT do banco externo — UMA vez, para todos os motores.
 *
 * O `SELECT` é MONTADO NO SERVIDOR: os identificadores são quotados e validados
 * contra o catálogo (`permitidas`) e os valores viram parâmetros — nunca
 * concatenação. O filtro é um vocabulário FECHADO de operadores; não existe
 * caminho por onde texto do usuário vire SQL.
 *
 * O que muda por motor é só a SINTAXE (`SintaxeSql`): como quotar um nome, como
 * marcar um valor e como comparar texto sem diferenciar caixa nem espaço. O
 * vocabulário de operadores, a validação de coluna e os tetos de linhas são os
 * mesmos nos dois — e por isso moram aqui, em um lugar só.
 *
 * O limite tem DOIS níveis: o `max_rows` da conexão e o teto absoluto
 * `LIMITE_LINHAS.maximo`, que nem o admin ultrapassa.
 */
import { LIMITE_LINHAS, LIMITE_PADRAO_DA_GRADE } from "./limites";
import type { OperadorDeFiltro, PedidoDeLeitura } from "./types";

export const LIMITE_PADRAO = LIMITE_PADRAO_DA_GRADE;

/** Acima disso, um valor de célula é truncado antes de virar JSON. */
export const MAX_TEXTO = 20_000;

export class LeituraInvalidaError extends Error {
  constructor(motivo: string) {
    super(motivo);
    this.name = "LeituraInvalidaError";
  }
}

export interface SintaxeSql {
  /** Quota um identificador (tabela, coluna, schema) sem deixá-lo fechar a aspa por conta própria. */
  quotar(nome: string): string;
  /** Registra o valor em `values` e devolve o marcador do motor (`$n` ou `?`). */
  marcador(values: unknown[], valor: unknown): string;
  /** Escapa `%`, `_` e o próprio caractere de escape para um `like`. */
  escaparLike(valor: string): string;
  /** `like` que ignora caixa e espaços; `marcadorDoPadrao` já é o marcador do valor. */
  comparaTexto(colunaQuotada: string, marcadorDoPadrao: string): string;
}

export const SINTAXE_POSTGRES: SintaxeSql = {
  quotar: (nome) => `"${nome.replace(/"/g, '""')}"`,
  marcador: (values, valor) => {
    values.push(valor);
    return `$${values.length}`;
  },
  escaparLike: (valor) => valor.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_"),
  comparaTexto: (coluna, marcador) =>
    `replace(lower(cast(${coluna} as text)), ' ', '') like ${marcador} escape '\\'`,
};

export const SINTAXE_MYSQL: SintaxeSql = {
  quotar: (nome) => `\`${nome.replace(/`/g, "``")}\``,
  marcador: (values, valor) => {
    values.push(valor);
    return "?";
  },
  // `!` no lugar da barra: a barra muda de sentido conforme o `sql_mode`
  // (`NO_BACKSLASH_ESCAPES`) e o `'\'` vindo do JavaScript não é portável.
  escaparLike: (valor) => valor.replace(/!/g, "!!").replace(/%/g, "!%").replace(/_/g, "!_"),
  comparaTexto: (coluna, marcador) =>
    `replace(lower(cast(${coluna} as char)), ' ', '') like ${marcador} escape '!'`,
};

function exigirColuna(coluna: string, permitidas: ReadonlySet<string>): void {
  if (!permitidas.has(coluna)) {
    throw new LeituraInvalidaError(`coluna_inexistente:${coluna}`);
  }
}

/** Traduz um filtro em cláusula + parâmetros. Reutiliza o vetor de values. */
function clausulaDeFiltro(
  sintaxe: SintaxeSql,
  operador: OperadorDeFiltro,
  colunaQuotada: string,
  valor: unknown,
  values: unknown[],
): string {
  const placeholder = (v: unknown): string => sintaxe.marcador(values, v);

  switch (operador) {
    case "eq":
      return valor === null || valor === undefined
        ? `${colunaQuotada} is null`
        : `${colunaQuotada} = ${placeholder(valor)}`;
    case "ne":
      return valor === null || valor === undefined
        ? `${colunaQuotada} is not null`
        : `${colunaQuotada} <> ${placeholder(valor)}`;
    case "gt":
      return `${colunaQuotada} > ${placeholder(valor)}`;
    case "gte":
      return `${colunaQuotada} >= ${placeholder(valor)}`;
    case "lt":
      return `${colunaQuotada} < ${placeholder(valor)}`;
    case "lte":
      return `${colunaQuotada} <= ${placeholder(valor)}`;
    case "contem": {
      // C-008: match TOLERANTE A ESPAÇOS. O modelo manda "cb250"/"CB250" e a base
      // tem "CB 250 F Twister" — o ILIKE simples devolvia ZERO linhas e a IA
      // concluía "não temos" mesmo existindo. Comparamos ignorando espaços e
      // caixa nos DOIS lados.
      const alvo = sintaxe.escaparLike(String(valor).toLowerCase().replace(/\s+/g, ""));
      return sintaxe.comparaTexto(colunaQuotada, placeholder(`%${alvo}%`));
    }
    case "comeca_com": {
      const alvo = sintaxe.escaparLike(String(valor).toLowerCase().replace(/\s+/g, ""));
      return sintaxe.comparaTexto(colunaQuotada, placeholder(`${alvo}%`));
    }
    case "in": {
      if (!Array.isArray(valor)) throw new LeituraInvalidaError("in_exige_array");
      if (valor.length === 0) return "false";
      const placeholders = valor.map((v) => placeholder(v));
      return `${colunaQuotada} in (${placeholders.join(", ")})`;
    }
    case "nulo":
      return `${colunaQuotada} is null`;
    case "nao_nulo":
      return `${colunaQuotada} is not null`;
    default: {
      const exaustivo: never = operador;
      throw new LeituraInvalidaError(`operador_desconhecido:${String(exaustivo)}`);
    }
  }
}

export interface ConsultaMontada {
  text: string;
  values: unknown[];
  limite: number;
  offset: number;
}

/**
 * Monta o SELECT. `permitidas` é o conjunto de colunas REAIS da tabela, lido do
 * catálogo — qualquer nome fora dele é recusado.
 */
export function montarConsultaCom(
  sintaxe: SintaxeSql,
  pedido: PedidoDeLeitura,
  permitidas: ReadonlySet<string>,
  opcoes: { limiteMax?: number } = {},
): ConsultaMontada {
  if (!pedido.schema || !pedido.tabela) {
    throw new LeituraInvalidaError("tabela_obrigatoria");
  }

  const colunas = [...new Set(pedido.colunas)];
  for (const c of colunas) exigirColuna(c, permitidas);

  const values: unknown[] = [];
  const clausulas: string[] = [];
  for (const filtro of pedido.filtros) {
    exigirColuna(filtro.coluna, permitidas);
    clausulas.push(clausulaDeFiltro(sintaxe, filtro.operador, sintaxe.quotar(filtro.coluna), filtro.valor, values));
  }

  let ordem = "";
  if (pedido.ordem) {
    exigirColuna(pedido.ordem.coluna, permitidas);
    ordem = ` order by ${sintaxe.quotar(pedido.ordem.coluna)} ${pedido.ordem.desc ? "desc" : "asc"}`;
  }

  // O teto efetivo é o da conexão, nunca acima do absoluto; um `limiteMax`
  // inválido (NaN/negativo) cai no absoluto em vez de abrir a porteira.
  const tetoDaConexao = Math.floor(opcoes.limiteMax ?? LIMITE_LINHAS.maximo);
  const teto = Math.min(
    LIMITE_LINHAS.maximo,
    Number.isFinite(tetoDaConexao) && tetoDaConexao > 0 ? tetoDaConexao : LIMITE_LINHAS.maximo,
  );
  const limite = Math.min(teto, Math.max(1, Math.floor(pedido.limite) || LIMITE_PADRAO));
  const offset = Math.max(0, Math.floor(pedido.offset) || 0);
  const projecao = colunas.length > 0 ? colunas.map((c) => sintaxe.quotar(c)).join(", ") : "*";
  const onde = clausulas.length > 0 ? ` where ${clausulas.join(" and ")}` : "";

  const text =
    `select ${projecao} from ${sintaxe.quotar(pedido.schema)}.${sintaxe.quotar(pedido.tabela)}` +
    `${onde}${ordem} limit ${limite} offset ${offset}`;

  return { text, values, limite, offset };
}

/**
 * Valor de célula pronto para virar JSON. `prefixoBinario` é do motor: o
 * PostgreSQL devolve bytea como `\x…`, o MySQL como `0x…`.
 */
export function serializarValor(v: unknown, prefixoBinario: string): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return `${prefixoBinario}${Buffer.from(v).toString("hex")}`;
  if (typeof v === "string" && v.length > MAX_TEXTO) {
    return `${v.slice(0, MAX_TEXTO)}…(truncado, ${v.length} chars)`;
  }
  return v;
}

export function serializarLinha(linha: Record<string, unknown>, prefixoBinario: string): Record<string, unknown> {
  const saida: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(linha)) saida[k] = serializarValor(v, prefixoBinario);
  return saida;
}
