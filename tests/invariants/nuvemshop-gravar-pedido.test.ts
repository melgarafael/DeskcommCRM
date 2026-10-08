import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * `fn_gravar_pedido_externo` (migration 0611): o pedido MAIS NOVO vence, o
 * anonimizado nunca é reescrito, contato de outra organização não é aceito, e
 * só `service_role` executa. `integration_sync_state` é lida pela org e escrita
 * só pelo servidor.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db`");

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});

const ORG_A = "c1a0f611-0000-4000-8000-00000000000a";
const ORG_B = "c1a0f611-0000-4000-8000-00000000000b";
const CONTATO_B = "c1a0f611-0000-4000-8000-0000000000cb";

function pedido(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    external_provider: "nuvemshop",
    external_id: "9001",
    customer_external_id: "77",
    contact_id: null,
    status: "pending",
    total_cents: 12345,
    currency: "BRL",
    payment_method: "pix",
    fulfillment_status: null,
    tracking_code: null,
    payload: { number: 1001 },
    ordered_at: "2026-09-01T10:00:00Z",
    updated_at_remote: "2026-09-01T10:00:00Z",
    ...over,
  };
}

async function gravar(org: string, p: Record<string, unknown>): Promise<string | null> {
  const { rows } = await pool.query<{ id: string | null }>(
    "select public.fn_gravar_pedido_externo($1, $2::jsonb) as id",
    [org, JSON.stringify(p)],
  );
  return rows[0]!.id;
}

async function linha(org: string, externalId = "9001") {
  const { rows } = await pool.query(
    `select status, total_cents, contact_id, is_anonymized from public.orders
      where organization_id = $1 and external_provider = 'nuvemshop' and external_id = $2`,
    [org, externalId],
  );
  return rows[0];
}

beforeAll(async () => {
  for (const [id, slug] of [
    [ORG_A, "ns-sync-a"],
    [ORG_B, "ns-sync-b"],
  ]) {
    await pool.query(
      "insert into organizations (id, slug, legal_name, display_name) values ($1, $2::text, $2::text, $2::text)",
      [id, slug],
    );
  }
  await pool.query(
    "insert into contacts (id, organization_id, name) values ($1, $2, 'Contato de B')",
    [CONTATO_B, ORG_B],
  );
});

afterAll(async () => {
  await pool.query("delete from orders where organization_id in ($1, $2)", [ORG_A, ORG_B]);
  await pool.query("delete from integration_sync_state where organization_id in ($1, $2)", [
    ORG_A,
    ORG_B,
  ]);
  await pool.query("delete from contacts where organization_id in ($1, $2)", [ORG_A, ORG_B]);
  await pool.query("delete from organizations where id in ($1, $2)", [ORG_A, ORG_B]);
  await pool.end();
});

describe("fn_gravar_pedido_externo", () => {
  it("insere na primeira vez e devolve o id", async () => {
    expect(await gravar(ORG_A, pedido())).toMatch(/^[0-9a-f-]{36}$/);
    expect((await linha(ORG_A))?.status).toBe("pending");
  });

  it("versão mais nova sobrescreve", async () => {
    await gravar(ORG_A, pedido({ status: "paid", updated_at_remote: "2026-09-02T10:00:00Z" }));
    expect((await linha(ORG_A))?.status).toBe("paid");
  });

  it("versão mais velha NÃO sobrescreve (webhook atrasado)", async () => {
    const id = await gravar(
      ORG_A,
      pedido({ status: "cancelled", updated_at_remote: "2026-09-01T12:00:00Z" }),
    );
    expect(id).toBeNull();
    expect((await linha(ORG_A))?.status).toBe("paid");
  });

  it("pedido anonimizado nunca é reescrito", async () => {
    await pool.query(
      `update orders set is_anonymized = true where organization_id = $1 and external_id = '9001'`,
      [ORG_A],
    );
    const id = await gravar(
      ORG_A,
      pedido({ status: "delivered", updated_at_remote: "2026-09-10T10:00:00Z" }),
    );
    expect(id).toBeNull();
    expect((await linha(ORG_A))?.status).toBe("paid");
  });

  it("contato de OUTRA organização vira null", async () => {
    await gravar(ORG_A, pedido({ external_id: "9002", contact_id: CONTATO_B }));
    expect((await linha(ORG_A, "9002"))?.contact_id).toBeNull();
  });

  it("anon e authenticated não executam; service_role executa", async () => {
    const { rows } = await pool.query<{ anon: boolean; auth: boolean; svc: boolean }>(
      `select has_function_privilege('anon', 'public.fn_gravar_pedido_externo(uuid, jsonb)', 'execute') as anon,
              has_function_privilege('authenticated', 'public.fn_gravar_pedido_externo(uuid, jsonb)', 'execute') as auth,
              has_function_privilege('service_role', 'public.fn_gravar_pedido_externo(uuid, jsonb)', 'execute') as svc`,
    );
    expect(rows[0]).toEqual({ anon: false, auth: false, svc: true });
  });
});

describe("integration_sync_state", () => {
  it("um estado por (org, provider, resource)", async () => {
    await pool.query(
      "insert into integration_sync_state (organization_id, provider, resource) values ($1, 'nuvemshop', 'orders')",
      [ORG_A],
    );
    await expect(
      pool.query(
        "insert into integration_sync_state (organization_id, provider, resource) values ($1, 'nuvemshop', 'orders')",
        [ORG_A],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("authenticated não tem privilégio de escrita", async () => {
    const { rows } = await pool.query<{ ins: boolean; upd: boolean; del: boolean }>(
      `select has_table_privilege('authenticated', 'public.integration_sync_state', 'insert') as ins,
              has_table_privilege('authenticated', 'public.integration_sync_state', 'update') as upd,
              has_table_privilege('authenticated', 'public.integration_sync_state', 'delete') as del`,
    );
    expect(rows[0]).toEqual({ ins: false, upd: false, del: false });
  });

  it("kind integracao_desautorizada aceito, um aviso aberto por integração", async () => {
    const ref = "c1a0f611-0000-4000-8000-0000000000e1";
    const inserir = () =>
      pool.query(
        `insert into agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
         values ($1, 'integracao_desautorizada', 'warn', 't', 'b', 'tenant_integration', $2)`,
        [ORG_A, ref],
      );
    await inserir();
    await expect(inserir()).rejects.toMatchObject({ code: "23505" });
    await pool.query("delete from agent_inbox_items where organization_id = $1", [ORG_A]);
  });
});
