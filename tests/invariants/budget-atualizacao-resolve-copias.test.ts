import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * A 0540 NUMA INSTALAÇÃO QUE JÁ RODOU A CORRIDA.
 *
 * `budget-nao-abre-em-dobro.test.ts` mede o índice num banco que já o tem. O
 * caminho que ele não alcança é o do `update.sh`: um banco de ANTES da 0540,
 * sem o índice e com avisos de orçamento repetidos que a corrida já abriu. Ali
 * o `create unique index` falharia com 23505 e a atualização pararia no meio —
 * quem impede é a passada `with repetidas ... update` que vem antes.
 *
 * O bloco é LIDO do `baseline.sql` pelo rótulo, e não copiado: é o texto que o
 * `update.sh` re-aplica. Uma linha de OUTRO kind com o mesmo par (organização,
 * kind) vizinho prova que a passada respeita o escopo: ela não é resolvida nem
 * entra no índice.
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

const ORG = "ed0c0000-0000-4000-8000-00000000005c";

const ROTULO_0540 =
  "-- ---- dedupe dos avisos de orçamento: índice único parcial (migration 0540) ----";

function blocoDa0540(): string {
  const baseline = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");
  const inicio = baseline.indexOf(ROTULO_0540);
  if (inicio === -1) throw new Error("rótulo da 0540 não encontrado no baseline");
  if (baseline.indexOf(ROTULO_0540, inicio + 1) !== -1)
    throw new Error("rótulo da 0540 repetido no baseline");
  const fim = baseline.indexOf("\n-- ---- ", inicio + ROTULO_0540.length);
  return baseline.slice(inicio, fim === -1 ? undefined : fim);
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1, $2::text, $2::text, $2::text)`,
    [ORG, "budget-copias"],
  );
});

afterAll(async () => {
  await pool.query(`delete from agent_inbox_items where organization_id = $1`, [ORG]);
  await pool.query(`delete from organizations where id = $1`, [ORG]);
  await pool.end();
});

describe("a 0540 re-aplicada sobre avisos repetidos", () => {
  it("fica o mais antigo de cada kind aberto, os outros são resolvidos, e o resto não é tocado", async () => {
    // Tudo numa transação desfeita no fim: o índice volta mesmo se o caso falhar.
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("drop index public.agent_inbox_budget_aberto_unico");
      const { rows: avisos } = await c.query<{ id: string }>(
        `insert into agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id, created_at)
         select $1, 'budget_warning', 'warn', 'O gasto de IA passou do aviso ' || n,
                'Motivo: teste', 'ai_budget', $1, now() - make_interval(mins => 10 - n)
           from generate_series(1, 3) n
          order by n
         returning id`,
        [ORG],
      );
      const maisAntigoDoLimiar = avisos[0]!.id;
      const { rows: bloqueios } = await c.query<{ id: string }>(
        `insert into agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id, created_at)
         select $1, 'budget_exceeded', 'critical', 'O orçamento de IA foi atingido ' || n,
                'Motivo: teste', 'ai_budget', $1, now() - make_interval(mins => 10 - n)
           from generate_series(1, 2) n
          order by n
         returning id`,
        [ORG],
      );
      const maisAntigoDoBloqueio = bloqueios[0]!.id;
      const doOutroKind = (
        await c.query<{ id: string }>(
          `insert into agent_inbox_items (organization_id, kind, severity, title, body)
           values ($1, 'midia_nao_lida', 'warn', 'O agente não conseguiu ler a mídia', 'Motivo: teste')
           returning id`,
          [ORG],
        )
      ).rows[0]!.id;

      await c.query(blocoDa0540());

      const { rows: limiar } = await c.query<{
        id: string;
        status: string;
        resolved_at: Date | null;
      }>(
        `select id, status, resolved_at from agent_inbox_items
          where organization_id = $1 and kind = 'budget_warning' order by created_at`,
        [ORG],
      );
      expect(limiar.filter((r) => r.status === "open").map((r) => r.id)).toEqual([
        maisAntigoDoLimiar,
      ]);
      expect(limiar.filter((r) => r.status === "resolved")).toHaveLength(2);
      expect(
        limiar.filter((r) => r.status === "resolved").every((r) => r.resolved_at !== null),
      ).toBe(true);

      const { rows: bloqueio } = await c.query<{
        id: string;
        status: string;
        resolved_at: Date | null;
      }>(
        `select id, status, resolved_at from agent_inbox_items
          where organization_id = $1 and kind = 'budget_exceeded' order by created_at`,
        [ORG],
      );
      expect(bloqueio.filter((r) => r.status === "open").map((r) => r.id)).toEqual([
        maisAntigoDoBloqueio,
      ]);
      expect(bloqueio.filter((r) => r.status === "resolved")).toHaveLength(1);
      expect(
        bloqueio.filter((r) => r.status === "resolved").every((r) => r.resolved_at !== null),
      ).toBe(true);

      const outro = await c.query<{ status: string }>(
        `select status from agent_inbox_items where id = $1`,
        [doOutroKind],
      );
      expect(outro.rows[0]!.status, "a passada mexeu num kind fora do escopo").toBe("open");

      const { rows: idx } = await c.query(
        `select 1 from pg_indexes where schemaname = 'public'
            and indexname = 'agent_inbox_budget_aberto_unico'`,
      );
      expect(idx.length, "o bloco do baseline não recriou o índice").toBe(1);
    } finally {
      await c.query("rollback");
      c.release();
    }
  });
});
