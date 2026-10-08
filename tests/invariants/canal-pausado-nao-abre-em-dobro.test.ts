import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * O AVISO DE CANAL PAUSADO NÃO ABRE EM DOBRO (issue #2389, migration 0589).
 *
 * `lib/channels/central-de-pausa.ts` lê "há aviso aberto?" e só depois
 * insere. Duas pausas simultâneas do mesmo canal (duplo clique no interruptor,
 * ou a pausa em lote junto com a unitária) leem "nenhum" ao mesmo tempo; sem
 * índice, abririam dois, e a retomada resolveria só um — o outro ficaria
 * dizendo "pausado" com o canal no ar. O índice único parcial
 * `agent_inbox_canal_pausado_aberto_unico` fecha a corrida no banco, e o
 * módulo trata o `23505` como "a outra rodada já abriu".
 *
 * Mede contra Postgres porque SQL não se prova com dublê:
 *
 *   1. o kind `canal_pausado` passa no CHECK, e o segundo aviso aberto do
 *      MESMO canal leva `23505`;
 *   2. a chave é o CANAL: outro canal da mesma organização abre o seu;
 *   3. a trava é por ORGANIZAÇÃO;
 *   4. resolvido o aviso, a próxima pausa abre outro.
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

const ORG_A = "ca0a0000-0000-4000-8000-00000000005a";
const ORG_B = "ca0a0000-0000-4000-8000-00000000005b";
const CANAL_1 = "ca0a0000-0000-4000-8000-0000000000c1";
const CANAL_2 = "ca0a0000-0000-4000-8000-0000000000c2";

async function tentar(org: string, canal: string): Promise<string | null> {
  try {
    await pool.query(
      `insert into agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
       values ($1, 'canal_pausado', 'warn', 'Este canal está pausado', 'teste', 'channel_session', $2)`,
      [org, canal],
    );
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? "sem-code";
  }
}

const abertos = async (org: string, canal: string): Promise<number> => {
  const { rows } = await pool.query<{ n: number }>(
    `select count(*)::int as n from agent_inbox_items
      where organization_id = $1 and kind = 'canal_pausado' and ref_id = $2 and status = 'open'`,
    [org, canal],
  );
  return rows[0]!.n;
};

beforeAll(async () => {
  for (const [id, slug] of [
    [ORG_A, "canal-pausado-a"],
    [ORG_B, "canal-pausado-b"],
  ]) {
    await pool.query(
      `insert into organizations (id, slug, legal_name, display_name) values ($1, $2::text, $2::text, $2::text)`,
      [id, slug],
    );
  }
});

afterAll(async () => {
  await pool.query(`delete from agent_inbox_items where organization_id in ($1, $2)`, [
    ORG_A,
    ORG_B,
  ]);
  await pool.query(`delete from organizations where id in ($1, $2)`, [ORG_A, ORG_B]);
  await pool.end();
});

describe("o aviso de canal pausado não abre em dobro", () => {
  it("o segundo aviso aberto do MESMO canal leva 23505, e sobra UMA linha aberta", async () => {
    expect(await tentar(ORG_A, CANAL_1), "o primeiro aviso foi recusado — CHECK ou índice barra o caso legítimo").toBeNull();
    expect(await tentar(ORG_A, CANAL_1), "o segundo aviso passou: a corrida das duas pausas continua aberta").toBe("23505");
    expect(await abertos(ORG_A, CANAL_1)).toBe(1);
  });

  it("a chave é o CANAL: outro canal da mesma organização abre o seu", async () => {
    expect(await tentar(ORG_A, CANAL_2), "o índice colapsou canais diferentes num só").toBeNull();
    expect(await abertos(ORG_A, CANAL_2)).toBe(1);
  });

  it("a trava é por ORGANIZAÇÃO", async () => {
    expect(await tentar(ORG_B, CANAL_1), "o índice está global em vez de por organização").toBeNull();
    expect(await abertos(ORG_B, CANAL_1)).toBe(1);
  });

  it("resolvido o aviso, a próxima pausa abre outro", async () => {
    await pool.query(
      `update agent_inbox_items set status = 'resolved', resolved_at = now()
        where organization_id = $1 and kind = 'canal_pausado' and ref_id = $2 and status = 'open'`,
      [ORG_A, CANAL_1],
    );
    expect(await tentar(ORG_A, CANAL_1), "o aviso não reabre depois de resolvido").toBeNull();
    expect(await abertos(ORG_A, CANAL_1)).toBe(1);
  });
});
