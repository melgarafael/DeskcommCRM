import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * A 0527 NUMA INSTALAÇÃO QUE JÁ RODOU A CORRIDA.
 *
 * `midia-nao-lida-nao-abre-em-dobro.test.ts` mede o índice num banco que já o
 * tem. O caminho que ele não alcança é o do `update.sh`: um banco de ANTES da
 * 0527, sem o índice e com avisos `midia_nao_lida` repetidos que a corrida já
 * abriu. Ali o `create unique index` falharia com 23505 e a atualização pararia
 * no meio — quem impede é a passada `with repetidas ... update` que vem antes.
 *
 * O bloco é LIDO do `baseline.sql` pelo rótulo, e não copiado: é o texto que o
 * `update.sh` re-aplica.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 1,
});

const ORG = "ed0c0000-0000-4000-8000-00000000000c";

const ROTULO_0527 =
  "-- ---- dedupe de midia_nao_lida atômico: índice único parcial (migration 0527) ----";

function blocoDa0527(): string {
  const baseline = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");
  const inicio = baseline.indexOf(ROTULO_0527);
  if (inicio === -1) throw new Error("rótulo da 0527 não encontrado no baseline");
  if (baseline.indexOf(ROTULO_0527, inicio + 1) !== -1)
    throw new Error("rótulo da 0527 repetido no baseline");
  const fim = baseline.indexOf("\n-- ---- ", inicio + ROTULO_0527.length);
  return baseline.slice(inicio, fim === -1 ? undefined : fim);
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1, $2::text, $2::text, $2::text)`,
    [ORG, "midia-copias"],
  );
});

afterAll(async () => {
  await pool.query(`delete from agent_inbox_items where organization_id = $1`, [ORG]);
  await pool.query(`delete from organizations where id = $1`, [ORG]);
  await pool.end();
});

describe("a 0527 re-aplicada sobre avisos repetidos", () => {
  it("fica o mais antigo aberto, os outros são resolvidos, e o índice nasce", async () => {
    // Tudo numa transação desfeita no fim: o índice volta mesmo se o caso falhar.
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("drop index public.agent_inbox_midia_nao_lida_aberto_unico");
      const { rows: ids } = await c.query<{ id: string }>(
        `insert into agent_inbox_items (organization_id, kind, severity, title, body, created_at)
         select $1, 'midia_nao_lida', 'warn', 'O agente não conseguiu ler a mídia ' || n,
                'Motivo: teste', now() - make_interval(mins => 10 - n)
           from generate_series(1, 3) n
          order by n
         returning id`,
        [ORG],
      );
      const maisAntigo = ids[0]!.id;

      await c.query(blocoDa0527());

      const { rows } = await c.query<{ id: string; status: string; resolved_at: Date | null }>(
        `select id, status, resolved_at from agent_inbox_items
          where organization_id = $1 and kind = 'midia_nao_lida' order by created_at`,
        [ORG],
      );
      expect(rows.filter((r) => r.status === "open").map((r) => r.id)).toEqual([maisAntigo]);
      const resolvidos = rows.filter((r) => r.status === "resolved");
      expect(resolvidos, "as cópias foram apagadas em vez de resolvidas").toHaveLength(2);
      expect(resolvidos.every((r) => r.resolved_at !== null)).toBe(true);

      const { rows: idx } = await c.query(
        `select 1 from pg_indexes where schemaname = 'public'
            and indexname = 'agent_inbox_midia_nao_lida_aberto_unico'`,
      );
      expect(idx.length, "o bloco do baseline não recriou o índice").toBe(1);
    } finally {
      await c.query("rollback");
      c.release();
    }
  });
});
