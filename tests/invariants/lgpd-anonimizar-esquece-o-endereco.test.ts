import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * Anonimizar apaga o endereço da pessoa física (migration 9041, issue #3494).
 *
 * As colunas de endereço de `contacts` (CEP, logradouro, número, complemento,
 * bairro, cidade, UF) nasceram depois das RPCs de LGPD, que zeram nome, e-mail,
 * telefone, CPF e nascimento e não sabem delas. Sem o gatilho
 * `trg_contato_anonimizado_esquece_o_endereco`, o "Cliente Anonimizado #N"
 * guardaria rua, número e CEP — o bastante para reidentificar o titular.
 *
 * A anonimização aqui é a RPC de verdade (`fn_lgpd_cascade_redact_contact`, que
 * o botão da ficha alcança por `fn_lgpd_anonymize_contact`), no Postgres de
 * verdade. O contato vizinho, com o mesmo endereço, é o controle: o gatilho
 * apaga só quem foi anonimizado.
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

const ORG = "e9de9041-0000-4000-8000-000000000001";
const REQ = "e9de9041-0000-4000-8000-000000000002";
const CONTATO = "e9de9041-0000-4000-8000-0000000000c1";
const CONTROLE = "e9de9041-0000-4000-8000-0000000000c2";

const ENDERECO = {
  zip_code: "80000-000",
  street: "Rua XV de Novembro",
  number: "120",
  complement: "apto 42",
  district: "Centro",
  city: "Curitiba",
  state: "PR",
} as const;
const COLUNAS = Object.keys(ENDERECO) as (keyof typeof ENDERECO)[];

async function enderecoDe(id: string): Promise<Record<string, string | null>> {
  const { rows } = await pool.query<Record<string, string | null>>(
    `select ${COLUNAS.join(", ")} from contacts where id = $1 and organization_id = $2`,
    [id, ORG],
  );
  const linha = rows[0];
  if (!linha) throw new Error(`contato ${id} sumiu`);
  return linha;
}

const NULO = Object.fromEntries(COLUNAS.map((c) => [c, null]));

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'endereco-lgpd-prova', 'Org de Prova', 'Org de Prova') on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into lgpd_requests (id, organization_id, request_type, source, scope, due_at)
     values ($1, $2, 'redact', 'manual', 'contact', now() + interval '15 days')
     on conflict (id) do nothing`,
    [REQ, ORG],
  );
  for (const [id, tel] of [
    [CONTATO, "+5541984490041"],
    [CONTROLE, "+5541984490042"],
  ] as const) {
    await pool.query(
      `insert into contacts (id, organization_id, phone_number, ${COLUNAS.join(", ")})
       values ($1, $2, $3, ${COLUNAS.map((_, i) => `$${i + 4}`).join(", ")})`,
      [id, ORG, tel, ...COLUNAS.map((c) => ENDERECO[c])],
    );
  }
});

afterAll(async () => {
  await pool.query(`delete from contacts where organization_id = $1`, [ORG]);
  await pool.query(`delete from lgpd_requests where organization_id = $1`, [ORG]);
  await pool.query(`delete from organizations where id = $1`, [ORG]);
  await pool.end();
});

describe("LGPD: o endereço da pessoa física sai junto", () => {
  it("a anonimização pela RPC zera as 7 colunas; o contato vizinho fica", async () => {
    expect(await enderecoDe(CONTATO)).toEqual(ENDERECO);

    await pool.query(`select fn_lgpd_cascade_redact_contact($1, $2, $3)`, [ORG, CONTATO, REQ]);

    expect(await enderecoDe(CONTATO)).toEqual(NULO);
    expect(await enderecoDe(CONTROLE)).toEqual(ENDERECO);
  });

  it("escrita posterior num contato já anonimizado não grava o endereço de volta", async () => {
    await pool.query(`update contacts set street = 'Rua XV de Novembro', zip_code = '80000-000' where id = $1`, [
      CONTATO,
    ]);
    expect(await enderecoDe(CONTATO)).toEqual(NULO);
  });
});
