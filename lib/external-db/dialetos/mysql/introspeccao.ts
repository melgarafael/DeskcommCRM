/**
 * Introspecção AO VIVO do MySQL. Mesmo contrato `TabelaExterna` do PostgreSQL.
 *
 * - A listagem fica PRESA ao banco da conexão (`table_schema = ?`, parâmetro,
 *   nunca concatenação): o catálogo do servidor (`information_schema`, `mysql`,
 *   `performance_schema`, `sys`) nunca aparece.
 * - `schema` da API = nome do banco; pedido com outro schema não existe.
 * - `SCHEMA` é palavra reservada no MySQL: o alias leva crase.
 * - Aliases em MINÚSCULA em todas as colunas (o MySQL 8 devolve MAIÚSCULA sem
 *   alias) e `coalesce(table_rows, 0)` porque view vem `NULL`.
 * - PK por `information_schema.statistics` (`index_name = 'PRIMARY'`), na ordem
 *   do índice, em UM `join` agrupado (não uma subconsulta por coluna).
 *
 * Fatos do servidor INFERIDOS (documentação): a Fatia 4a-2b os mede, inclusive o
 * custo num WordPress de verdade e se o catálogo respeita os privilégios (C1f, C1g).
 */
import { consultarMysql, type PoolMysql } from "./conexao";
import type { TabelaExterna } from "../../types";

interface LinhaCatalogo {
  schema: string;
  nome: string;
  tipo: string;
  coluna: string;
  tipo_dado: string;
  nulavel: string;
  posicao: number;
  /** `group_concat` das colunas da PK, separadas por vírgula, ou `null`. */
  chave_primaria: string | null;
  estimativa: string | number | null;
}

const SQL_CATALOGO = `
  select
    c.table_schema      as \`schema\`,
    c.table_name        as nome,
    t.table_type        as tipo,
    c.column_name       as coluna,
    c.data_type         as tipo_dado,
    c.is_nullable       as nulavel,
    c.ordinal_position  as posicao,
    pk.colunas          as chave_primaria,
    coalesce(t.table_rows, 0) as estimativa
  from information_schema.columns c
  join information_schema.tables t
    on t.table_schema = c.table_schema and t.table_name = c.table_name
  left join (
    select s.table_name as nome,
           group_concat(s.column_name order by s.seq_in_index separator ',') as colunas
    from information_schema.statistics s
    where s.table_schema = ? and s.index_name = 'PRIMARY'
    group by s.table_name
  ) pk on pk.nome = c.table_name
  where c.table_schema = ?
    and t.table_type in ('BASE TABLE', 'VIEW')
`;

function tipoDe(t: string): TabelaExterna["tipo"] {
  if (t === "BASE TABLE") return "tabela";
  if (t === "VIEW") return "view";
  return "outro";
}

function pkComoLista(valor: string | null): string[] {
  if (!valor) return [];
  return valor
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

function agrupar(rows: LinhaCatalogo[]): TabelaExterna[] {
  const mapa = new Map<string, TabelaExterna>();
  for (const r of rows) {
    const chave = `${r.schema}\u0000${r.nome}`;
    let tabela = mapa.get(chave);
    if (!tabela) {
      tabela = {
        schema: r.schema,
        nome: r.nome,
        tipo: tipoDe(r.tipo),
        colunas: [],
        chavePrimaria: pkComoLista(r.chave_primaria),
        estimativaLinhas: Math.max(0, Math.round(Number(r.estimativa) || 0)),
      };
      mapa.set(chave, tabela);
    }
    tabela.colunas.push({
      nome: r.coluna,
      tipo: r.tipo_dado,
      nulavel: r.nulavel === "YES",
      posicao: Number(r.posicao),
    });
  }
  return [...mapa.values()];
}

/** Todas as tabelas e views do banco da conexão, com as colunas. `database` = o banco cadastrado. */
export async function listarTabelasMysql(pool: PoolMysql, database: string): Promise<TabelaExterna[]> {
  const { rows } = await consultarMysql<LinhaCatalogo>(
    pool,
    `${SQL_CATALOGO} order by c.table_name, c.ordinal_position`,
    [database, database],
  );
  return agrupar(rows);
}

/** Retrato de uma tabela/view. `null` quando não existe — inclusive quando o `schema` pedido não é o banco da conexão. */
export async function descreverTabelaMysql(
  pool: PoolMysql,
  database: string,
  schema: string,
  tabela: string,
): Promise<TabelaExterna | null> {
  if (schema !== database) return null;
  const { rows } = await consultarMysql<LinhaCatalogo>(
    pool,
    `${SQL_CATALOGO} and c.table_name = ? order by c.ordinal_position`,
    [database, database, tabela],
  );
  const [primeira] = agrupar(rows);
  return primeira ?? null;
}

export async function colunasDaTabelaMysql(
  pool: PoolMysql,
  database: string,
  schema: string,
  tabela: string,
): Promise<Set<string> | null> {
  const descricao = await descreverTabelaMysql(pool, database, schema, tabela);
  if (!descricao) return null;
  return new Set(descricao.colunas.map((c) => c.nome));
}
