import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { AVISO_DO_JEV } from "@/lib/ai/decisao/textos";

/**
 * A 0539 NUMA INSTALAÇÃO QUE JÁ RODOU A CORRIDA.
 *
 * `avisos-other-por-titulo-nao-abrem-em-dobro.test.ts` mede o índice num banco
 * que já o tem. O caminho que ele não alcança é o do `update.sh`: um banco de
 * ANTES da 0539, sem o índice e com avisos de título repetidos que a corrida já
 * abriu — o próprio comentário do aviso do Jev pedia "deduplicar os avisos
 * abertos de todo clone" antes do índice. Ali o `create unique index` falharia
 * com 23505 e a atualização pararia no meio.
 *
 * O bloco é LIDO do `baseline.sql` pelo rótulo, e não copiado: é o texto que o
 * `update.sh` re-aplica. O aviso de ref PRÓPRIA com o mesmo título (dois leads)
 * prova que a passada respeita o grão: ele não é resolvido nem entra no índice.
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

const ORG = "ed0c0000-0000-4000-8000-00000000004c";
const LEAD_1 = "ed0c0000-0000-4000-8000-0000000000d5";
const LEAD_2 = "ed0c0000-0000-4000-8000-0000000000d6";
const JEV = AVISO_DO_JEV.titulo;
const OUTRO = "O endereço da empresa exige a chave da empresa";
const TITULO_DO_LEAD = "Espelho de stage no CRM falhou — funil possivelmente inconsistente";

const ROTULO_0539 =
  "-- ---- dedupe dos avisos other por título: índice único parcial (migration 0539) ----";

function blocoDa0539(): string {
  const baseline = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");
  const inicio = baseline.indexOf(ROTULO_0539);
  if (inicio === -1) throw new Error("rótulo da 0539 não encontrado no baseline");
  if (baseline.indexOf(ROTULO_0539, inicio + 1) !== -1)
    throw new Error("rótulo da 0539 repetido no baseline");
  const fim = baseline.indexOf("\n-- ---- ", inicio + ROTULO_0539.length);
  return baseline.slice(inicio, fim === -1 ? undefined : fim);
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1, $2::text, $2::text, $2::text)`,
    [ORG, "other-titulo-copias"],
  );
});

afterAll(async () => {
  await pool.query(`delete from agent_inbox_items where organization_id = $1`, [ORG]);
  await pool.query(`delete from organizations where id = $1`, [ORG]);
  await pool.end();
});

describe("a 0539 re-aplicada sobre avisos repetidos", () => {
  it("fica o mais antigo aberto, os outros são resolvidos, e o grão de ref própria não é tocado", async () => {
    // Tudo numa transação desfeita no fim: o índice volta mesmo se o caso falhar.
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("drop index public.agent_inbox_other_por_titulo_aberto_unico");
      const { rows: ids } = await c.query<{ id: string }>(
        `insert into agent_inbox_items (organization_id, kind, severity, title, body, created_at)
         select $1, 'other', 'warn', $2, 'Motivo: teste', now() - make_interval(mins => 10 - n)
           from generate_series(1, 3) n
          order by n
         returning id`,
        [ORG, JEV],
      );
      const maisAntigo = ids[0]!.id;
      const doOutroTitulo = (
        await c.query<{ id: string }>(
          `insert into agent_inbox_items (organization_id, kind, severity, title, body)
           values ($1, 'other', 'warn', $2, 'Motivo: teste')
           returning id`,
          [ORG, OUTRO],
        )
      ).rows[0]!.id;
      const { rows: dosLeads } = await c.query<{ id: string }>(
        `insert into agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
         values ($1, 'other', 'warn', $2, 'Motivo: teste', 'lead', $3),
                ($1, 'other', 'warn', $2, 'Motivo: teste', 'lead', $4)
         returning id`,
        [ORG, TITULO_DO_LEAD, LEAD_1, LEAD_2],
      );

      await c.query(blocoDa0539());

      const { rows } = await c.query<{ id: string; status: string; resolved_at: Date | null }>(
        `select id, status, resolved_at from agent_inbox_items
          where organization_id = $1 and kind = 'other' and title = $2
          order by created_at`,
        [ORG, JEV],
      );
      expect(rows.filter((r) => r.status === "open").map((r) => r.id)).toEqual([maisAntigo]);
      const resolvidos = rows.filter((r) => r.status === "resolved");
      expect(resolvidos, "as cópias foram apagadas em vez de resolvidas").toHaveLength(2);
      expect(resolvidos.every((r) => r.resolved_at !== null)).toBe(true);

      const outro = await c.query<{ status: string }>(
        `select status from agent_inbox_items where id = $1`,
        [doOutroTitulo],
      );
      expect(outro.rows[0]!.status, "a passada mexeu num aviso de outro título").toBe("open");

      const leads = await c.query<{ status: string }>(
        `select status from agent_inbox_items where id = any($1::uuid[])`,
        [dosLeads.map((r) => r.id)],
      );
      expect(
        leads.rows.map((r) => r.status),
        "a passada tocou o grão de ref própria (dois leads com o mesmo título)",
      ).toEqual(["open", "open"]);

      const { rows: idx } = await c.query(
        `select 1 from pg_indexes where schemaname = 'public'
            and indexname = 'agent_inbox_other_por_titulo_aberto_unico'`,
      );
      expect(idx.length, "o bloco do baseline não recriou o índice").toBe(1);
    } finally {
      await c.query("rollback");
      c.release();
    }
  });
});
