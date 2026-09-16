/**
 * Leitura paginada de uma tabela/view do banco externo.
 *
 * O `SELECT` é MONTADO NO SERVIDOR: os identificadores são quotados e validados
 * contra o catálogo (`permitidas`), e os valores viram parâmetros `$n` — nunca
 * concatenação. O filtro é um vocabulário FECHADO de operadores; não existe
 * caminho por onde texto do usuário vire SQL.
 *
 * O limite tem DOIS níveis: o `max_rows` configurado na conexão (o que a
 * organização escolheu) e o teto absoluto `LIMITE_LINHAS.maximo`, que nem o
 * admin ultrapassa. Sem teto nenhum, um `select *` numa tabela de milhões de
 * linhas derruba o processo do worker.
 */
import type pg from "pg";

import { consultar } from "./conexao";
import { LIMITE_LINHAS, LIMITE_PADRAO_DA_GRADE } from "./limites";
import type { OperadorDeFiltro, PedidoDeLeitura } from "./types";

export const LIMITE_PADRAO = LIMITE_PADRAO_DA_GRADE;

/** Acima disso, um valor de célula é truncado antes de virar JSON. */
const MAX_TEXTO = 20_000;

export class LeituraInvalidaError extends Error {
  constructor(motivo: string) {
    super(motivo);
    this.name = "LeituraInvalidaError";
  }
}

/** Aspas duplas escapadas: um identificador nunca fecha a aspa por conta própria. */
export function quotarIdentificador(nome: string): string {
  return `"${nome.replace(/"/g, '""')}"`;
}

function escaparLike(valor: string): string {
  return valor.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function exigirColuna(coluna: string, permitidas: ReadonlySet<string>): void {
  if (!permitidas.has(coluna)) {
    throw new LeituraInvalidaError(`coluna_inexistente:${coluna}`);
  }
}

/** Traduz um filtro em cláusula + parâmetros. Reutiliza o vetor de values. */
function clausulaDeFiltro(
  operador: OperadorDeFiltro,
  colunaQuotada: string,
  valor: unknown,
  values: unknown[],
): string {
  const placeholder = (v: unknown): string => {
    values.push(v);
    return `$${values.length}`;
  };

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
      // concluía "não temos" (e "sem foto") mesmo existindo. Comparamos ignorando
      // espaços e caixa nos DOIS lados.
      const alvo = escaparLike(String(valor).toLowerCase().replace(/\s+/g, ""));
      return `replace(lower(cast(${colunaQuotada} as text)), ' ', '') like ${placeholder(`%${alvo}%`)} escape '\\'`;
    }
    case "comeca_com": {
      const alvo = escaparLike(String(valor).toLowerCase().replace(/\s+/g, ""));
      return `replace(lower(cast(${colunaQuotada} as text)), ' ', '') like ${placeholder(`${alvo}%`)} escape '\\'`;
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
export function montarConsulta(
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
    clausulas.push(clausulaDeFiltro(filtro.operador, quotarIdentificador(filtro.coluna), filtro.valor, values));
  }

  let ordem = "";
  if (pedido.ordem) {
    exigirColuna(pedido.ordem.coluna, permitidas);
    ordem = ` order by ${quotarIdentificador(pedido.ordem.coluna)} ${pedido.ordem.desc ? "desc" : "asc"}`;
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
  const projecao = colunas.length > 0 ? colunas.map(quotarIdentificador).join(", ") : "*";
  const onde = clausulas.length > 0 ? ` where ${clausulas.join(" and ")}` : "";

  const text =
    `select ${projecao} from ${quotarIdentificador(pedido.schema)}.${quotarIdentificador(pedido.tabela)}` +
    `${onde}${ordem} limit ${limite} offset ${offset}`;

  return { text, values, limite, offset };
}

function serializarValor(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Uint8Array) return `\\x${Buffer.from(v).toString("hex")}`;
  if (typeof v === "string" && v.length > MAX_TEXTO) {
    return `${v.slice(0, MAX_TEXTO)}…(truncado, ${v.length} chars)`;
  }
  return v;
}

function serializarLinha(linha: Record<string, unknown>): Record<string, unknown> {
  const saida: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(linha)) saida[k] = serializarValor(v);
  return saida;
}

export interface ResultadoDeLeitura {
  colunas: string[];
  linhas: Record<string, unknown>[];
  limite: number;
  offset: number;
}

export async function lerTabela(
  pool: pg.Pool,
  pedido: PedidoDeLeitura,
  permitidas: ReadonlySet<string>,
  opcoes: { limiteMax?: number } = {},
): Promise<ResultadoDeLeitura> {
  const { text, values, limite, offset } = montarConsulta(pedido, permitidas, opcoes);
  const resultado = await consultar<Record<string, unknown>>(pool, text, values);
  return {
    colunas: resultado.fields.map((f) => f.name),
    linhas: resultado.rows.map(serializarLinha),
    limite,
    offset,
  };
}
