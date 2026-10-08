import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * Anonimizar apaga o nome salvo na agenda do celular (migration 0593, PR #2439).
 *
 * `contacts.address_book_name` é o rótulo que alguém da empresa escreveu no
 * celular — dado pessoal, e às vezes o apelido mais identificável da ficha. O
 * gatilho `trg_contato_anonimizado_esquece_a_agenda` age em NEW, então vale em
 * qualquer caminho que deixe a linha anonimizada. Aqui a anonimização é a RPC
 * de verdade (`fn_lgpd_cascade_redact_contact`), no Postgres de verdade.
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

const ORG = "a9e0da00-0000-4000-8000-000000000001";
const REQ = "a9e0da00-0000-4000-8000-000000000002";
const CONTATO = "a9e0da00-0000-4000-8000-0000000000c1";
const CONTROLE = "a9e0da00-0000-4000-8000-0000000000c2";

async function agendaDe(id: string): Promise<string | null> {
  const { rows } = await pool.query<{ address_book_name: string | null }>(
    `select address_book_name from contacts where id = $1 and organization_id = $2`,
    [id, ORG],
  );
  return rows[0]?.address_book_name ?? null;
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'agenda-lgpd-prova', 'Org de Prova', 'Org de Prova') on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into lgpd_requests (id, organization_id, request_type, source, scope, due_at)
     values ($1, $2, 'redact', 'manual', 'contact', now() + interval '15 days')
     on conflict (id) do nothing`,
    [REQ, ORG],
  );
  for (const [id, tel] of [
    [CONTATO, "+5562984480025"],
    [CONTROLE, "+5562984480026"],
  ] as const) {
    await pool.query(
      `insert into contacts (id, organization_id, phone_number, address_book_name)
       values ($1, $2, $3, 'Maria caloteira')`,
      [id, ORG, tel],
    );
  }
});

afterAll(async () => {
  await pool.query(`delete from contacts where organization_id = $1`, [ORG]);
  await pool.query(`delete from lgpd_requests where organization_id = $1`, [ORG]);
  await pool.query(`delete from organizations where id = $1`, [ORG]);
  await pool.end();
});

describe("LGPD: o nome da agenda sai junto", () => {
  it("a anonimização pela RPC zera address_book_name; o contato vizinho fica", async () => {
    expect(await agendaDe(CONTATO)).toBe("Maria caloteira");

    await pool.query(`select fn_lgpd_cascade_redact_contact($1, $2, $3)`, [ORG, CONTATO, REQ]);

    expect(await agendaDe(CONTATO)).toBeNull();
    expect(await agendaDe(CONTROLE)).toBe("Maria caloteira");
  });

  it("escrita posterior num contato já anonimizado não grava o nome de volta", async () => {
    await pool.query(`update contacts set address_book_name = 'Maria caloteira' where id = $1`, [CONTATO]);
    expect(await agendaDe(CONTATO)).toBeNull();
  });
});
