/**
 * Aplica um arquivo de migration SQL direto no Postgres (SUPABASE_DB_URL).
 *
 * Uso: pnpm exec tsx scripts/aplicar-migration.ts supabase/migrations/XXXX.sql
 * As migrations do repo são idempotentes por construção (if not exists).
 */
import pg from "pg";
import { readFileSync } from "node:fs";

import { carregarEnvLocal } from "./lib/env-de-teste";

async function main(): Promise<void> {
  const arquivo = process.argv[2];
  if (!arquivo) throw new Error("Passe o arquivo: scripts/aplicar-migration.ts <arquivo.sql>");
  const env = carregarEnvLocal();
  // ADMIN (conexão direta, porta 5432) primeiro: DDL não passa pelo pooler
  // de transação. Cai para SUPABASE_DB_URL quando for a única definida.
  const url = (env.SUPABASE_DB_ADMIN_URL as string) || (env.SUPABASE_DB_URL as string);
  if (!url) throw new Error("Sem SUPABASE_DB_ADMIN_URL nem SUPABASE_DB_URL no ambiente.");
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    await pool.query(readFileSync(arquivo, "utf8"));
    // eslint-disable-next-line no-console
    console.log(`OK: ${arquivo}`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
   
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
