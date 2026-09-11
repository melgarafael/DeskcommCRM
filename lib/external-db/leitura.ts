/**
 * Leitura paginada de uma tabela/view do banco externo.
 *
 * O `SELECT` é MONTADO NO SERVIDOR: os identificadores são quotados e validados
 * contra o catálogo (`permitidas`), e os valores viram parâmetros `$n` — nunca
 * concatenação. O filtro é um vocabulário FECHADO de operadores; não existe
 * caminho por onde texto do usuário vire SQL.
 *
 * O limite é teto rígido (`LIMITE_MAX`): sem ele, um `select *` numa tabela de
 * milhões de linhas derruba o processo do worker.
 */
import type pg from "pg";

import { consultar } from "./conexao";
import type { OperadorDeFiltro, PedidoDeLeitura } from "./types";

export const LIMITE_MAX = 200;
export const LIMITE_PADRAO = 50;

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
    case "contem":
      return `cast(${colunaQuotada} as text) ilike ${placeholder(`%${escaparLike(String(valor))}%`)} escape '\\'`;
    case "comeca_com":
      return `cast(${colunaQuotada} as text) ilike ${placeholder(`${escaparLike(String(valor))}%`)} escape '\\'`;
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

  const limite = Math.min(LIMITE_MAX, Math.max(1, Math.floor(pedido.limite) || LIMITE_PADRAO));
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
): Promise<ResultadoDeLeitura> {
  const { text, values, limite, offset } = montarConsulta(pedido, permitidas);
  const resultado = await consultar<Record<string, unknown>>(pool, text, values);
  return {
    colunas: resultado.fields.map((f) => f.name),
    linhas: resultado.rows.map(serializarLinha),
    limite,
    offset,
  };
}
