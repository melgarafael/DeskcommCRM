/**
 * Introspecção AO VIVO do banco externo.
 *
 * Nada de schema espelhado: as tabelas mudam com frequência, então o retrato é
 * lido do catálogo na hora da consulta. Toda a leitura passa por
 * `consultar()` (transação somente-leitura) e por `information_schema` +
 * `pg_catalog` — portável entre Postgres e Supabase, sem depender de extensão.
 *
 * `pg_catalog` é excluído da listagem: o operador quer ver os dados dele, não
 * as 60 e poucas tabelas internas. Views entram junto com tabelas — muita vez é
 * por view que o outro sistema expõe o dado.
 */
import type pg from "pg";

import { consultar } from "./conexao";
import type { TabelaExterna } from "./types";

interface LinhaCatalogo {
  schema: string;
  nome: string;
  tipo: string;
  coluna: string;
  tipo_dado: string;
  nulavel: string;
  posicao: number;
  /**
   * A PK chega como `text[]` (OID 1009, que o driver parseia) ou como o literal
   * cru `"{id}"` quando o driver não conhece o OID do array de origem (`name[]`
   * = 1003). O cast no SQL resolve, e `normalizarPk` blinda contra o literal.
   */
  chave_primaria: string[] | string | null;
  estimativa: string | number;
}

const SQL_CATALOGO = `
  select
    c.table_schema      as schema,
    c.table_name        as nome,
    t.table_type        as tipo,
    c.column_name       as coluna,
    c.data_type         as tipo_dado,
    c.is_nullable       as nulavel,
    c.ordinal_position  as posicao,
    pk.colunas          as chave_primaria,
    coalesce(cl.reltuples, 0) as estimativa
  from information_schema.columns c
  join information_schema.tables t
    on t.table_schema = c.table_schema and t.table_name = c.table_name
  left join pg_catalog.pg_namespace n
    on n.nspname = c.table_schema
  left join pg_catalog.pg_class cl
    on cl.relname = c.table_name and cl.relnamespace = n.oid
    left join (
      select i.indrelid, array_agg(a.attname order by k.ord)::text[] as colunas
      from pg_catalog.pg_index i
    cross join lateral unnest(i.indkey) with ordinality as k(attnum, ord)
    join pg_catalog.pg_attribute a
      on a.attrelid = i.indrelid and a.attnum = k.attnum
    where i.indisprimary
    group by i.indrelid
  ) pk on pk.indrelid = cl.oid
  where c.table_schema not in ('pg_catalog', 'information_schema', 'pg_toast')
    and t.table_type in ('BASE TABLE', 'VIEW')
`;

function tipoDe(t: string): TabelaExterna["tipo"] {
  if (t === "BASE TABLE") return "tabela";
  if (t === "VIEW") return "view";
  return "outro";
}

/**
 * Garante que a PK seja SEMPRE `string[]`.
 *
 * O driver `pg` parseia `text[]`, mas não todo array do Postgres: quando a
 * função devolvia `name[]`, o valor chegava como o literal cru (`"{id}"`) e o
 * contrato `TabelaExterna.chavePrimaria: string[]` era violado em silêncio — a
 * tela marcava "PK" por acidente (`.includes` funciona em string) e quebrava ao
 * iterar. O cast no SQL já resolve na origem; isto é a rede.
 */
function normalizarPk(valor: string[] | string | null | undefined): string[] {
  if (Array.isArray(valor)) return valor.map((v) => String(v));
  if (typeof valor !== "string") return [];
  const interno = valor.trim().replace(/^\{/, "").replace(/\}$/, "").trim();
  if (!interno) return [];
  return interno
    .split(",")
    .map((parte) => parte.trim().replace(/^"(.*)"$/, "$1"))
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
        chavePrimaria: normalizarPk(r.chave_primaria),
        estimativaLinhas: Math.max(0, Math.round(Number(r.estimativa) || 0)),
      };
      mapa.set(chave, tabela);
    }
    tabela.colunas.push({
      nome: r.coluna,
      tipo: r.tipo_dado,
      nulavel: r.nulavel === "YES",
      posicao: r.posicao,
    });
  }
  return [...mapa.values()];
}

/** Todas as tabelas e views visíveis ao usuário da conexão, com suas colunas. */
export async function listarTabelas(pool: pg.Pool): Promise<TabelaExterna[]> {
  const { rows } = await consultar<LinhaCatalogo>(
    pool,
    `${SQL_CATALOGO} order by c.table_schema, c.table_name, c.ordinal_position`,
  );
  return agrupar(rows);
}

/** Retrato de uma tabela/view específica. `null` quando ela não existe. */
export async function descreverTabela(
  pool: pg.Pool,
  schema: string,
  tabela: string,
): Promise<TabelaExterna | null> {
  const { rows } = await consultar<LinhaCatalogo>(
    pool,
    `${SQL_CATALOGO}
      and c.table_schema = $1 and c.table_name = $2
     order by c.ordinal_position`,
    [schema, tabela],
  );
  const [primeira] = agrupar(rows);
  return primeira ?? null;
}

/**
 * Nomes de coluna da tabela, para validar o pedido de leitura. `null` quando a
 * tabela não existe — o chamador distingue "não existe" de "existe sem colunas".
 */
export async function colunasDaTabela(
  pool: pg.Pool,
  schema: string,
  tabela: string,
): Promise<Set<string> | null> {
  const descricao = await descreverTabela(pool, schema, tabela);
  if (!descricao) return null;
  return new Set(descricao.colunas.map((c) => c.nome));
}
