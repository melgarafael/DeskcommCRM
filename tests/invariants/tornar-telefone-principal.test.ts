import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * "TORNAR PRINCIPAL" (Spec 31, parte B2 — migration 9048).
 *
 * A troca precisa ser UMA operação: feita em dois passos pela rota, o principal
 * novo colidiria com o próprio extra na regra "um número, uma ficha" (9043), e
 * um processo que caísse no meio deixaria a ficha sem o número antigo.
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

const ORG = "9042a000-0000-4000-8000-000000000001";
const OUTRA = "9042a000-0000-4000-8000-000000000002";

let seq = 0;
function uid(): string {
  seq += 1;
  return `9042c000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
}

async function ficha(org: string, phone: string, lid: string | null) {
  const id = uid();
  await pool.query(
    "insert into contacts (id, organization_id, phone_number, source_metadata) values ($1, $2, $3, $4)",
    [id, org, phone, lid ? { waha_lid: lid, waha_chat_id: `${lid}@lid` } : {}],
  );
  return id;
}

async function extra(org: string, contato: string, phone: string, lid: string | null) {
  const { rows } = await pool.query<{ id: string }>(
    `insert into contact_phones (organization_id, contact_id, phone_number, wa_lid, whatsapp, tipo)
     values ($1, $2, $3, $4, 'sim', 'celular') returning id`,
    [org, contato, phone, lid],
  );
  return rows[0]!.id;
}

beforeAll(async () => {
  for (const [id, slug] of [
    [ORG, "org-9042-principal-a"],
    [OUTRA, "org-9042-principal-b"],
  ] as const) {
    await pool.query(
      `insert into organizations (id, slug, legal_name, display_name)
       values ($1, $2, 'Principal LTDA', 'Principal') on conflict (id) do nothing`,
      [id, slug],
    );
  }
});

afterAll(async () => {
  await pool.query("delete from organizations where id in ($1, $2)", [ORG, OUTRA]);
  await pool.end();
});

describe("fn_tornar_telefone_principal", () => {
  it("troca os dois, cada um com o seu tipo, WhatsApp e lid", async () => {
    const id = await ficha(ORG, "+551533330001", "90420010000001");
    const ext = await extra(ORG, id, "+5515999990002", "90420020000002");

    await pool.query("select public.fn_tornar_telefone_principal($1, $2, $3)", [ORG, id, ext]);

    const { rows: c } = await pool.query(
      `select phone_number, phone_type, phone_whatsapp, wa_lid, source_metadata->>'waha_chat_id' as chat
         from contacts where id = $1`,
      [id],
    );
    expect(c[0]).toEqual({
      phone_number: "+5515999990002",
      phone_type: "celular",
      phone_whatsapp: "sim",
      wa_lid: "90420020000002",
      chat: null,
    });
    const { rows: t } = await pool.query(
      "select phone_number, tipo, wa_lid, origem from contact_phones where organization_id = $1 and contact_id = $2",
      [ORG, id],
    );
    // Sabotagem: tirar o `insert` do principal antigo deixa a lista vazia.
    expect(t).toEqual([{ phone_number: "+551533330001", tipo: "fixo", wa_lid: "90420010000001", origem: "manual" }]);
  });

  it("o rótulo anda com o número, nos dois sentidos (#4242, item 2)", async () => {
    const id = await ficha(ORG, "+5511942420001", null);
    await pool.query("update contacts set phone_label = $2 where id = $1", [id, "Casa"]);
    const { rows: criado } = await pool.query<{ id: string }>(
      `insert into contact_phones (organization_id, contact_id, phone_number, whatsapp, tipo, rotulo)
       values ($1, $2, $3, 'sim', 'celular', 'Trabalho') returning id`,
      [ORG, id, "+5511942420002"],
    );
    const ext = criado[0]!.id;

    await pool.query("select public.fn_tornar_telefone_principal($1, $2, $3)", [ORG, id, ext]);

    // Sabotagem: tirar `phone_label = v_extra.rotulo` do update faz o rótulo do
    // promovido sumir; tirar `v_ficha.phone_label` do insert o perde do outro lado.
    const { rows: c } = await pool.query("select phone_label from contacts where id = $1", [id]);
    expect(c[0]!.phone_label).toBe("Trabalho");
    const { rows: t } = await pool.query(
      "select rotulo from contact_phones where organization_id = $1 and contact_id = $2",
      [ORG, id],
    );
    expect(t).toEqual([{ rotulo: "Casa" }]);
  });

  it("ficha sem telefone não guarda rótulo: remoção e anonimização o levam junto (migration 9354)", async () => {
    // Sabotagem: tirar o gatilho `trg_contacts_rotulo_sai_com_o_numero` deixa o
    // texto livre do rótulo nas duas fichas — inclusive na anonimizada.
    const removida = await ficha(ORG, "+5511942420101", null);
    await pool.query("update contacts set phone_label = 'Casa da mãe' where id = $1", [removida]);
    await pool.query("update contacts set phone_number = null where id = $1", [removida]);

    const anonimizada = await ficha(ORG, "+5511942420102", null);
    await pool.query("update contacts set phone_label = 'Casa da mãe' where id = $1", [anonimizada]);
    await pool.query("select fn_lgpd_cascade_redact_contact($1, $2, null)", [ORG, anonimizada]);

    const { rows } = await pool.query(
      "select phone_number, phone_label from contacts where id = any($1::uuid[]) order by phone_label nulls first",
      [[removida, anonimizada]],
    );
    expect(rows).toEqual([
      { phone_number: null, phone_label: null },
      { phone_number: null, phone_label: null },
    ]);
  });

  it("extra de outra organização é recusado e nada muda", async () => {
    const id = await ficha(ORG, "+551533330101", null);
    const alheia = await ficha(OUTRA, "+551533330102", null);
    const extAlheio = await extra(OUTRA, alheia, "+5515999990103", null);

    // Sabotagem: tirar `t.organization_id = p_org` da busca do extra.
    await expect(
      pool.query("select public.fn_tornar_telefone_principal($1, $2, $3)", [ORG, id, extAlheio]),
    ).rejects.toMatchObject({ code: "P0002" });
    const { rows } = await pool.query("select phone_number from contacts where id = $1", [id]);
    expect(rows[0]!.phone_number).toBe("+551533330101");
  });

  it("anon não executa", async () => {
    const { rows } = await pool.query<{ pode: boolean }>(
      "select has_function_privilege('anon', 'public.fn_tornar_telefone_principal(uuid, uuid, uuid)', 'execute') as pode",
    );
    expect(rows[0]!.pode).toBe(false);
  });
});
