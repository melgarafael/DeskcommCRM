/**
 * Leitura paginada do MySQL. A montagem do SELECT e o vocabulário de filtros são
 * os de `lib/external-db/montagem.ts` (comuns aos motores); aqui só a sintaxe do
 * MySQL, o `execute` e o formato do binário (`0x…`).
 */
import { LeituraInvalidaError, SINTAXE_MYSQL, montarConsultaCom, serializarLinha } from "../../montagem";
import type { ResultadoDeLeitura } from "../../leitura";
import type { PedidoDeLeitura } from "../../types";
import { consultarMysql, type PoolMysql } from "./conexao";

export async function lerTabelaMysql(
  pool: PoolMysql,
  database: string,
  pedido: PedidoDeLeitura,
  permitidas: ReadonlySet<string>,
  opcoes: { limiteMax?: number } = {},
): Promise<ResultadoDeLeitura> {
  // No MySQL o "schema" da API é o banco da conexão; qualquer outro não existe aqui.
  if (pedido.schema !== database) throw new LeituraInvalidaError("schema_inexistente");
  const { text, values, limite, offset } = montarConsultaCom(SINTAXE_MYSQL, pedido, permitidas, opcoes);
  const resultado = await consultarMysql<Record<string, unknown>>(pool, text, values);
  return {
    colunas: resultado.fields.map((f) => f.name),
    linhas: resultado.rows.map((l) => serializarLinha(l, "0x")),
    limite,
    offset,
  };
}
