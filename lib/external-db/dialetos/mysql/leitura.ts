/**
 * Leitura paginada do MySQL. A montagem do SELECT e o vocabulário de filtros são
 * os de `lib/external-db/montagem.ts` (comuns aos motores); aqui só a sintaxe do
 * MySQL, o `execute` e o formato do binário (`0x…`).
 *
 * `executarReceitaMysql` roda o SQL já montado pela receita (placeholders `?`),
 * dentro da mesma armadura do `lerTabelaMysql`: transação `START TRANSACTION
 * READ ONLY` + timeouts refeitos a cada empréstimo (`consultarMysql`,
 * `dialetos/mysql/conexao.ts:143`), serialização com prefixo `0x`, corte em
 * `limiteMax` e teto de bytes da conexão (`max_response_bytes`, com
 * `truncado: true` quando corta).
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

/**
 * Executa uma receita pronta: o SQL já vem montado com placeholders `?` e os
 * valores ligados. Não monta nada — só executa, serializa, corta e trunca por
 * bytes da conexão.
 */
export async function executarReceitaMysql(
  pool: PoolMysql,
  _database: string,
  consulta: { sql: string; valores: unknown[]; tabelas: string[]; colunasPorTabela: Record<string, string[]> },
  maxResponseBytes: number,
  opcoes: { limiteMax: number },
): Promise<ResultadoDeLeitura & { truncado: boolean }> {
  const resultado = await consultarMysql<Record<string, unknown>>(pool, consulta.sql, consulta.valores);

  const colunas = resultado.fields.map((f) => f.name);
  let linhas = resultado.rows.map((l) => serializarLinha(l, "0x"));

  // Corte pelo teto de itens da receita (opcoes.limiteMax).
  const limiteMax = Math.max(1, Math.floor(opcoes.limiteMax) || 1);
  let truncado = false;
  if (linhas.length > limiteMax) {
    linhas = linhas.slice(0, limiteMax);
    truncado = true;
  }

  // Teto de bytes da resposta: mesmo mecanismo da tool crm_query_external_data.
  const linhasDevolvidas: Record<string, unknown>[] = [];
  let bytes = 0;
  for (const linha of linhas) {
    const tamanho = JSON.stringify(linha).length;
    if (linhasDevolvidas.length > 0 && bytes + tamanho > maxResponseBytes) {
      truncado = true;
      break;
    }
    linhasDevolvidas.push(linha);
    bytes += tamanho;
  }

  return {
    colunas,
    linhas: linhasDevolvidas,
    limite: limiteMax,
    offset: 0,
    truncado,
  };
}
