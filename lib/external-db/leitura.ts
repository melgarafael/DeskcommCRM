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
 *
 * A montagem do SELECT mora em `montagem.ts` (comum aos motores); aqui só o PostgreSQL.
 */
import type pg from "pg";

import { consultar } from "./conexao";
import {
  LeituraInvalidaError,
  LIMITE_PADRAO,
  SINTAXE_POSTGRES,
  montarConsultaCom,
  serializarLinha,
  type ConsultaMontada,
} from "./montagem";
import type { PedidoDeLeitura } from "./types";

export { LeituraInvalidaError, LIMITE_PADRAO };
export type { ConsultaMontada };

/** Aspas duplas escapadas: um identificador nunca fecha a aspa por conta própria. */
export function quotarIdentificador(nome: string): string {
  return SINTAXE_POSTGRES.quotar(nome);
}

export function montarConsulta(
  pedido: PedidoDeLeitura,
  permitidas: ReadonlySet<string>,
  opcoes: { limiteMax?: number } = {},
): ConsultaMontada {
  return montarConsultaCom(SINTAXE_POSTGRES, pedido, permitidas, opcoes);
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
    linhas: resultado.rows.map((l) => serializarLinha(l, "\\x")),
    limite,
    offset,
  };
}
