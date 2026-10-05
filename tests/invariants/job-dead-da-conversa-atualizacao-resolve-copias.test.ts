import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * A 0538 NUMA INSTALAÇÃO QUE JÁ RODOU A CORRIDA.
 *
 * `job-dead-da-conversa-nao-abre-em-dobro.test.ts` mede o índice num banco que
 * já o tem. O caminho que ele não alcança é o do `update.sh`: um banco de ANTES
 * da 0538, sem o índice e com avisos de conversa repetidos que a corrida já
 * abriu. Ali o `create unique index` falharia com 23505 e a atualização pararia
 * no meio — quem impede é a passada `with repetidas ... update` que vem antes.
 *
 * O bloco é LIDO do `baseline.sql` pelo rótulo, e não copiado: é o texto que o
 * `update.sh` re-aplica. A linha de `job_queue` com o MESMO ref_id prova que a
 * passada respeita o grão: `job_dead` de ocorrência não é resolvido nem entra no
 * índice.
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

const ORG = "ed0c0000-0000-4000-8000-00000000002c";
const CONVERSA = "ed0c0000-0000-4000-8000-0000000000c3";

const ROTULO_0538 =
  "-- ---- dedupe do job_dead da conversa atômico: índice único parcial (migration 0538) ----";

function blocoDa0538(): string {
  const baseline = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");
  const inicio = baseline.indexOf(ROTULO_0538);
  if (inicio === -1) throw new Error("rótulo da 0538 não encontrado no baseline");
  if (baseline.indexOf(ROTULO_0538, inicio + 1) !== -1)
    throw new Error("rótulo da 0538 repetido no baseline");
  const fim = baseline.indexOf("\n-- ---- ", inicio + ROTULO_0538.length);
  return baseline.slice(inicio, fim === -1 ? undefined : fim);
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1, $2::text, $2::text, $2::text)`,
    [ORG, "job-dead-copias"],
  );
});

afterAll(async () => {
  await pool.query(`delete from agent_inbox_items where organization_id = $1`, [ORG]);
  await pool.query(`delete from organizations where id = $1`, [ORG]);
  await pool.end();
});

describe("a 0538 re-aplicada sobre avisos repetidos", () => {
  it("fica o mais antigo aberto, os outros são resolvidos, o registro de ocorrência não é tocado, e o índice nasce", async () => {
    // Tudo numa transação desfeita no fim: o índice volta mesmo se o caso falhar.
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("drop index public.agent_inbox_job_dead_conversa_aberto_unico");
      const { rows: ids } = await c.query<{ id: string }>(
        `insert into agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id, created_at)
         select $1, 'job_dead', 'warn', 'Resposta registrada; atendimento mudou',
                'Motivo: teste', 'conversation', $2, now() - make_interval(mins => 10 - n)
           from generate_series(1, 3) n
          order by n
         returning id`,
        [ORG, CONVERSA],
      );
      const maisAntigo = ids[0]!.id;
      const doJob = (
        await c.query<{ id: string }>(
          `insert into agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
           values ($1, 'job_dead', 'critical', 'Job descartado após esgotar tentativas',
                   'Motivo: teste', 'job_queue', $2)
           returning id`,
          [ORG, CONVERSA],
        )
      ).rows[0]!.id;

      await c.query(blocoDa0538());

      const { rows } = await c.query<{ id: string; status: string; resolved_at: Date | null }>(
        `select id, status, resolved_at from agent_inbox_items
          where organization_id = $1 and kind = 'job_dead' and ref_kind = 'conversation'
          order by created_at`,
        [ORG],
      );
      expect(rows.filter((r) => r.status === "open").map((r) => r.id)).toEqual([maisAntigo]);
      const resolvidos = rows.filter((r) => r.status === "resolved");
      expect(resolvidos, "as cópias foram apagadas em vez de resolvidas").toHaveLength(2);
      expect(resolvidos.every((r) => r.resolved_at !== null)).toBe(true);

      const registro = await c.query<{ status: string; resolved_at: Date | null }>(
        `select status, resolved_at from agent_inbox_items where id = $1`,
        [doJob],
      );
      expect(
        registro.rows[0],
        "a passada mexeu no registro de ocorrência da fila (ref_kind fora do grão)",
      ).toMatchObject({ status: "open", resolved_at: null });

      const { rows: idx } = await c.query(
        `select 1 from pg_indexes where schemaname = 'public'
            and indexname = 'agent_inbox_job_dead_conversa_aberto_unico'`,
      );
      expect(idx.length, "o bloco do baseline não recriou o índice").toBe(1);
    } finally {
      await c.query("rollback");
      c.release();
    }
  });
});
