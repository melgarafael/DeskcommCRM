import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * `fn_mesclar_contatos` herda o `social_identity` do contato que sai (#1455, PR #1596).
 *
 * O teste irmão `tests/unit/fusao-de-contato-herda-a-identidade-social.test.ts`
 * lê o TEXTO da função; este a EXECUTA. A prova que importa é o reencontro: a
 * mesma consulta de `upsertSocialContact` (lib/channels/zernio/ingest.ts) tem
 * de achar o vencedor depois da fusão — sem a herança ela não acha ninguém vivo
 * e a próxima DM refaz a duplicata que a fusão acabou de desfazer.
 *
 * A guarda do "terceiro contato vivo" não ganha caso: com o índice parcial
 * `contacts_org_social_identity_unique`, um perdedor vivo e um terceiro vivo não
 * podem ter a mesma identidade antes da fusão, então o ramo é defensivo — o
 * mesmo desenho das guardas de e-mail, telefone e `waha_lid`.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 3,
});

const ORG = "d1596000-0000-4000-8000-000000000001";

async function contato(id: string, socialIdentity: string | null, nome: string | null = null) {
  await pool.query(
    "insert into contacts (id, organization_id, name, social_identity) values ($1, $2, $3, $4)",
    [id, ORG, nome, socialIdentity],
  );
  return id;
}

async function mesclar(principal: string, secundarios: string[]) {
  await pool.query("select public.fn_mesclar_contatos($1, $2, $3)", [ORG, principal, secundarios]);
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'org-1596-social', 'Social LTDA', 'Social') on conflict (id) do nothing`,
    [ORG],
  );
});

afterAll(async () => {
  await pool.query("delete from organizations where id = $1", [ORG]);
  await pool.end();
});

describe("fn_mesclar_contatos — a identidade social segue o vencedor", () => {
  it("o perdedor entrega a identidade e a próxima DM acha a ficha viva", async () => {
    const vencedor = await contato("d1596001-0000-4000-8000-000000000001", null, "Maria");
    const perdedor = await contato("d1596001-0000-4000-8000-000000000002", "instagram:account:1596001");

    await mesclar(vencedor, [perdedor]);

    const { rows } = await pool.query<{ id: string }>(
      `select id from contacts
        where organization_id = $1 and social_identity = $2 and is_merged_into is null`,
      [ORG, "instagram:account:1596001"],
    );
    expect(rows.map((r) => r.id)).toEqual([vencedor]);
  });

  it("a identidade que o vencedor já tinha NÃO é sobrescrita", async () => {
    const vencedor = await contato(
      "d1596002-0000-4000-8000-000000000001",
      "instagram:account:1596002-vencedor",
      "Ana",
    );
    const perdedor = await contato(
      "d1596002-0000-4000-8000-000000000002",
      "instagram:account:1596002-perdedor",
    );

    await mesclar(vencedor, [perdedor]);

    const { rows } = await pool.query<{ social_identity: string }>(
      "select social_identity from contacts where id = $1",
      [vencedor],
    );
    expect(rows[0]!.social_identity).toBe("instagram:account:1596002-vencedor");
  });
});
