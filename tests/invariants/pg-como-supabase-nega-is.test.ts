import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { pgComoSupabase } from "../pg-como-supabase";

/**
 * O ADAPTADOR NEGA `is` — `.not(col, "is", null)`, medido antes de medir.
 *
 * Nasceu pela cascata de LGPD (0497): `completarRedacaoDoContato` só apaga a
 * transcrição da mensagem que AINDA a tem. Um `not(is)` que não filtrasse
 * traria (e reescreveria) a tabela inteira, e a idempotência da varredura
 * seria de mentira. Arquivo próprio porque `pg-como-supabase.test.ts` está sob
 * o congelamento de `tests/invariants/**`; a régua é a mesma de lá.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${Number(process.env.TEST_DB_PORT ?? 54329)}/postgres`,
  max: 2,
});
const db = pgComoSupabase(pool);

const ORG = "ada57e00-0000-4000-8000-000000000497";

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'org-adaptador-nega-is', 'Adaptador Nega Is', 'Adaptador Nega Is') on conflict (id) do nothing`,
    [ORG],
  );
  // O trigger de seed criou o "Pedidos" (default). Estes são os extras: só
  // "Alfa" tem descrição.
  await pool.query(
    `insert into crm_pipelines (organization_id, name, slug, is_default, position, description) values
       ($1, 'Alfa',  'alfa',  false, 10, 'tem texto'),
       ($1, 'Bravo', 'bravo', false, 20, null),
       ($1, 'Zulu',  'zulu',  false, 30, null)
     on conflict do nothing`,
    [ORG],
  );
});

afterAll(async () => {
  await pool.query("delete from organizations where id = $1", [ORG]);
  await pool.end();
});

describe("o adaptador NEGA `is` — `.not(col, \"is\", null)`", () => {
  it("na LEITURA traz só quem não é null", async () => {
    const { data } = await db
      .from("crm_pipelines")
      .select("name")
      .eq("organization_id", ORG)
      .eq("is_default", false)
      .not("description", "is", null);
    expect((data as Array<{ name: string }>).map((x) => x.name)).toEqual(["Alfa"]);
  });

  it("na ESCRITA só alcança quem não é null", async () => {
    const { data } = await db
      .from("crm_pipelines")
      .update({ description: "reescrita" })
      .eq("organization_id", ORG)
      .eq("is_default", false)
      .not("description", "is", null)
      .select("name");
    expect((data as Array<{ name: string }>).map((x) => x.name)).toEqual(["Alfa"]);
  });
});
