import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * O AVISO DO TETO DO PLANO E O DO ORÇAMENTO DA ORG CONVIVEM (migration 0583, seção G).
 *
 * Os dois abrem `budget_exceeded`: o do orçamento com `ref_kind = 'ai_budget'`
 * (ou nulo, nas linhas antigas), o do plano com `ref_kind = 'plano'`. A 0540
 * pôs um índice único em (organização, kind) — com ele, quem chegasse primeiro
 * calava o outro, e a Central explicava a parada da IA pela causa errada. Este
 * arquivo mede, contra Postgres:
 *
 *   1. os dois abertos juntos na mesma org;
 *   2. cada família continua com UM aberto por org (23505 no segundo), e o
 *      nulo antigo é da família do orçamento;
 *   3. o bloco da 0540 que o `update.sh` re-aplica não resolve o do plano;
 *   4. o bloco da 0583 troca o índice da forma antiga e, reaplicado, não mexe.
 *
 * Os blocos são LIDOS do `baseline.sql` pelo rótulo: é o texto que o kit aplica.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});

const ORG = "c0de0552-0000-4000-8000-0000000000a1";

const ROTULO_0540 =
  "-- ---- dedupe dos avisos de orçamento: índice único parcial (migration 0540) ----";
const ROTULO_0583 =
  "-- ---- cobrança do revendedor: o aviso do teto do plano não é calado pelo do orçamento (migration 0583) ----";

function bloco(rotulo: string): string {
  const baseline = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");
  const inicio = baseline.indexOf(rotulo);
  if (inicio === -1) throw new Error(`rótulo não encontrado no baseline: ${rotulo}`);
  if (baseline.indexOf(rotulo, inicio + 1) !== -1) throw new Error(`rótulo repetido: ${rotulo}`);
  const fim = baseline.indexOf("\n-- ---- ", inicio + rotulo.length);
  return baseline.slice(inicio, fim === -1 ? undefined : fim);
}

type Cliente = Pick<pg.PoolClient, "query">;

async function abrir(c: Cliente, refKind: string | null): Promise<string | null> {
  try {
    await c.query(
      `insert into agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
       values ($1, 'budget_exceeded', 'critical', 'IA parada', 'Motivo: teste', $2, $1)`,
      [ORG, refKind],
    );
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? "sem_codigo";
  }
}

async function abertos(c: Cliente): Promise<Array<string | null>> {
  const { rows } = await c.query<{ ref_kind: string | null }>(
    `select ref_kind from agent_inbox_items
      where organization_id = $1 and kind = 'budget_exceeded' and status = 'open'
      order by ref_kind nulls first`,
    [ORG],
  );
  return rows.map((r) => r.ref_kind);
}

async function definicoes(c: Cliente): Promise<Record<string, string>> {
  const { rows } = await c.query<{ indexname: string; indexdef: string }>(
    `select indexname, indexdef from pg_indexes
      where schemaname = 'public' and tablename = 'agent_inbox_items'
        and indexname in ('agent_inbox_budget_aberto_unico', 'agent_inbox_budget_do_plano_aberto_unico')`,
  );
  return Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef.replace(/\s+/g, " ").toLowerCase()]));
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1, $2::text, $2::text, $2::text)`,
    [ORG, "cobranca-aviso-plano"],
  );
});

beforeEach(async () => {
  await pool.query(`delete from agent_inbox_items where organization_id = $1`, [ORG]);
});

afterAll(async () => {
  await pool.query(`delete from agent_inbox_items where organization_id = $1`, [ORG]);
  await pool.query(`delete from organizations where id = $1`, [ORG]);
  await pool.end();
});

describe("o aviso do plano e o do orçamento", () => {
  it("abrem juntos na mesma org, nas duas ordens", async () => {
    expect(await abrir(pool, "ai_budget")).toBeNull();
    expect(await abrir(pool, "plano"), "o do orçamento calou o do plano").toBeNull();
    expect(await abertos(pool)).toEqual(["ai_budget", "plano"]);

    await pool.query(`delete from agent_inbox_items where organization_id = $1`, [ORG]);
    expect(await abrir(pool, "plano")).toBeNull();
    expect(await abrir(pool, "ai_budget"), "o do plano calou o do orçamento").toBeNull();
    expect(await abertos(pool)).toEqual(["ai_budget", "plano"]);
  });

  it("cada família segue com um aberto por org; o nulo antigo é da família do orçamento", async () => {
    expect(await abrir(pool, "plano")).toBeNull();
    expect(await abrir(pool, "plano")).toBe("23505");
    expect(await abrir(pool, null)).toBeNull();
    expect(await abrir(pool, "ai_budget")).toBe("23505");
    expect(await abertos(pool)).toEqual([null, "plano"]);
  });
});

describe("os blocos que o update.sh re-aplica", () => {
  it("o da 0540 não resolve o aviso do plano aberto ao lado do do orçamento", async () => {
    expect(await abrir(pool, "ai_budget")).toBeNull();
    expect(await abrir(pool, "plano")).toBeNull();
    await pool.query(bloco(ROTULO_0540));
    expect(await abertos(pool)).toEqual(["ai_budget", "plano"]);
  });

  it("o da 0583 troca o índice da forma da 0540 e, reaplicado, não mexe", async () => {
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("drop index public.agent_inbox_budget_aberto_unico");
      await c.query("drop index public.agent_inbox_budget_do_plano_aberto_unico");
      await c.query(`create unique index agent_inbox_budget_aberto_unico
        on public.agent_inbox_items (organization_id, kind)
        where status = 'open' and kind in ('budget_exceeded','budget_warning')`);
      // Controle: na forma da 0540 o plano é calado.
      expect(await abrir(c, "ai_budget")).toBeNull();
      await c.query("savepoint s");
      expect(await abrir(c, "plano")).toBe("23505");
      await c.query("rollback to savepoint s");

      await c.query(bloco(ROTULO_0583));
      const depois = await definicoes(c);
      expect(depois.agent_inbox_budget_aberto_unico).toContain("(organization_id, kind)");
      expect(depois.agent_inbox_budget_aberto_unico).toContain("ref_kind is distinct from 'plano'::text");
      expect(depois.agent_inbox_budget_do_plano_aberto_unico).toContain("(organization_id)");
      expect(depois.agent_inbox_budget_do_plano_aberto_unico).toContain("ref_kind = 'plano'::text");
      expect(await abrir(c, "plano")).toBeNull();

      const { rows: antes } = await c.query<{ oid: string }>(
        `select 'public.agent_inbox_budget_aberto_unico'::regclass::oid::text as oid`,
      );
      await c.query(bloco(ROTULO_0583));
      const { rows: reaplicado } = await c.query<{ oid: string }>(
        `select 'public.agent_inbox_budget_aberto_unico'::regclass::oid::text as oid`,
      );
      expect(reaplicado[0]!.oid, "reaplicar derrubou e recriou o índice").toBe(antes[0]!.oid);
    } finally {
      await c.query("rollback");
      c.release();
    }
  });
});
