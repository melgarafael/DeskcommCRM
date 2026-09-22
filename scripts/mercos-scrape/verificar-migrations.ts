/** Confere as tabelas/colunas das migrations 0226-0229 no banco. */
import pg from "pg";

import { carregarEnvLocal } from "../lib/env-de-teste";

async function main(): Promise<void> {
  const env = carregarEnvLocal();
  const url = (env.SUPABASE_DB_ADMIN_URL as string) || (env.SUPABASE_DB_URL as string);
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const tabelas = await pool.query(
      "select tablename from pg_tables where schemaname='public' and tablename in ('commercial_commission_baixas','commercial_titulo_baixas','commercial_tasks','commercial_activities') order by 1",
    );
    const colunas = await pool.query(
      `select column_name, data_type from information_schema.columns
       where table_schema='public' and table_name='catalog_products'
       and column_name in ('comissao_pct','destaque','preco_promocional_cents','promocao_ate') order by 1`,
    );
    const comissao = await pool.query(
      "select count(*)::int as n from catalog_products where comissao_pct is not null",
    );
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        tabelas: (tabelas.rows as { tablename: string }[]).map((r) => r.tablename),
        colunas: colunas.rows,
        comissao_preenchida: (comissao.rows as { n: number }[])[0]?.n,
      }),
    );
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
