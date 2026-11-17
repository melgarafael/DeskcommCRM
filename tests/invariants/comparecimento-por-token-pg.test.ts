import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * COMPARECIMENTO POR TOKEN, CONTRA POSTGRES REAL (#4515, migration 9396).
 *
 * A rota e a ferramenta MCP entram por service role, onde `auth.uid()` é nulo, e
 * o gatilho `fn_appointment_stamp` recusa o desfecho sem pessoa. Os testes de
 * rota (`comparecimento-por-token.test.ts`) usam dublê do banco e por isso não
 * atravessam o gatilho — foi exatamente assim que a prova pela tela do #4523
 * viu 403 com os testes de unidade verdes. Este arquivo mede a regra onde ela
 * mora:
 *
 *   · sem o RPC, o service role continua barrado (o comportamento de antes);
 *   · com o RPC e um token vivo da MESMA organização com `agenda:attendance`,
 *     o desfecho é gravado, carimbado `api_token` e com o id do token;
 *   · token sem o escopo, revogado, vencido ou de outra organização não grava;
 *   · compromisso de outra organização é inalcançável;
 *   · a GUC forjada sem o RPC não autoriza (o gatilho revalida o token);
 *   · sessão comum e anon não executam o RPC, e a GUC não muda o caminho de
 *     quem tem `auth.uid()`.
 */
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
});
const tenants = [0, 1].map(() => ({ org: randomUUID(), manager: randomUUID(), viewer: randomUUID() }));
type Tenant = (typeof tenants)[number];

type Papel = "anon" | "authenticated" | "service_role";

/** Uma transação por sonda, com o papel e o JWT dela; recusa não contamina a seguinte. */
async function comoPapel<T>(
  role: Papel,
  user: string | null,
  corpo: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`set local role ${role}`);
    await client.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ role, aal: "aal1", ...(user ? { sub: user } : {}) }),
    ]);
    const r = await corpo(client);
    await client.query("commit");
    return r;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

const RPC = "select fn_appointment_record_attendance($1,$2,1,$3,$4) result";
const CHANGE = "select fn_appointment_change($1,$2,1,$3) result";

beforeAll(async () => {
  for (const tenant of tenants) {
    await pool.query(
      "insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Presença por token','Presença por token')",
      [tenant.org],
    );
    for (const role of ["manager", "viewer"] as const) {
      const user = tenant[role];
      await pool.query("insert into auth.users(id,email) values($1,$2)", [user, `${user}@invariant.test`]);
      await pool.query(
        "insert into user_organizations(user_id,organization_id,role,accepted_at) values($1,$2,$3,now())",
        [user, tenant.org, role],
      );
    }
  }
});
afterAll(() => pool.end());

async function compromisso(tenant: Tenant, quando = "now()-interval '2 hours'") {
  const contact = randomUUID(),
    id = randomUUID();
  await pool.query(
    "insert into contacts(id,organization_id,display_name) values($1,$2,'Presença por token')",
    [contact, tenant.org],
  );
  await pool.query(
    `insert into calendar_appointments(id,organization_id,contact_id,title,starts_at,ends_at,status)
     values($1,$2,$3,'Presença por token',${quando},${quando}+interval '1 hour','confirmed')`,
    [id, tenant.org, contact],
  );
  return id;
}

async function token(
  tenant: Tenant,
  escopos: string[],
  extra: { revogado?: boolean; vencido?: boolean } = {},
) {
  const r = await pool.query(
    `insert into api_tokens(organization_id,created_by,name,prefix,token_hash,scopes,expires_at,revoked_at)
     values($1,$2,'integração',$3,decode(md5(random()::text),'hex'),$4::jsonb,$5,$6) returning id`,
    [
      tenant.org,
      tenant.manager,
      `dsk_${randomUUID().slice(0, 8)}`,
      JSON.stringify(escopos),
      extra.vencido ? new Date(Date.now() - 60_000) : null,
      extra.revogado ? new Date() : null,
    ],
  );
  return r.rows[0].id as string;
}

async function estado(id: string) {
  return (
    await pool.query(
      "select status,revision::int revision,outcome_source_kind,outcome_api_token_id,outcome_user_id from calendar_appointments where id=$1",
      [id],
    )
  ).rows[0];
}
const INTOCADO = {
  status: "confirmed",
  revision: 1,
  outcome_source_kind: null,
  outcome_api_token_id: null,
  outcome_user_id: null,
};

describe("comparecimento por token atravessa o gatilho do banco só pela porta certa", () => {
  it("sem o RPC, o service role continua barrado pelo gatilho (o 403 da prova do #4523)", async () => {
    const a = tenants[0]!;
    const id = await compromisso(a);
    await expect(
      comoPapel("service_role", null, (c) => c.query(CHANGE, [a.org, id, { status: "completed" }])),
    ).rejects.toMatchObject({ code: "42501", message: "appointment_human_confirmation_required" });
    expect(await estado(id)).toEqual(INTOCADO);
  });

  it("token vivo da organização com agenda:attendance registra, nos dois sentidos A/B, e carimba QUAL token", async () => {
    for (const tenant of tenants) {
      const tok = await token(tenant, ["mcp:write", "agenda:attendance"]);
      const realizado = await compromisso(tenant);
      const r = (
        await comoPapel("service_role", null, (c) =>
          c.query(RPC, [tenant.org, realizado, { status: "completed" }, tok]),
        )
      ).rows[0].result;
      expect(r).toMatchObject({
        id: realizado,
        organization_id: tenant.org,
        status: "completed",
        revision: 2,
        outcome_source_kind: "api_token",
        outcome_api_token_id: tok,
        outcome_user_id: null,
      });

      // NÃO COMPARECEU sai pelo MESMO evento que a tela emite para a recuperação.
      const faltou = await compromisso(tenant);
      await comoPapel("service_role", null, (c) =>
        c.query(RPC, [tenant.org, faltou, { status: "no_show" }, tok]),
      );
      expect(await estado(faltou)).toMatchObject({ status: "no_show", outcome_api_token_id: tok });
      expect(
        (
          await pool.query(
            "select count(*)::int n from event_log where organization_id=$1 and entity_id=$2 and event_type='appointment.outcome_confirmed'",
            [tenant.org, faltou],
          )
        ).rows[0].n,
      ).toBe(1);
    }
  });

  it("token sem o escopo, revogado ou vencido não grava nada", async () => {
    const a = tenants[0]!;
    const casos = [
      await token(a, ["mcp:write"]),
      await token(a, ["mcp:write", "agenda:attendance"], { revogado: true }),
      await token(a, ["mcp:write", "agenda:attendance"], { vencido: true }),
    ];
    for (const tok of casos) {
      const id = await compromisso(a);
      await expect(
        comoPapel("service_role", null, (c) => c.query(RPC, [a.org, id, { status: "completed" }, tok])),
      ).rejects.toMatchObject({ code: "42501", message: "attendance_scope_required" });
      expect(await estado(id)).toEqual(INTOCADO);
    }
  });

  it("a organização vem do token: token de B não age em A, e token de A não alcança compromisso de B", async () => {
    const [a, b] = [tenants[0]!, tenants[1]!];
    const tokA = await token(a, ["mcp:write", "agenda:attendance"]);
    const tokB = await token(b, ["mcp:write", "agenda:attendance"]);
    const deA = await compromisso(a);
    const deB = await compromisso(b);

    await expect(
      comoPapel("service_role", null, (c) => c.query(RPC, [a.org, deA, { status: "completed" }, tokB])),
    ).rejects.toMatchObject({ code: "42501", message: "attendance_scope_required" });
    await expect(
      comoPapel("service_role", null, (c) => c.query(RPC, [a.org, deB, { status: "completed" }, tokA])),
    ).rejects.toMatchObject({ code: "P0002" });
    expect(await estado(deA)).toEqual(INTOCADO);
    expect(await estado(deB)).toEqual(INTOCADO);
  });

  it("o RPC só registra desfecho, e compromisso futuro continua recusado", async () => {
    const a = tenants[0]!;
    const tok = await token(a, ["mcp:write", "agenda:attendance"]);
    const passado = await compromisso(a);
    await expect(
      comoPapel("service_role", null, (c) => c.query(RPC, [a.org, passado, { status: "cancelled" }, tok])),
    ).rejects.toMatchObject({ code: "22023", message: "attendance_status_invalid" });
    // Sem status no patch: `null not in (...)` é nulo, e sem a guarda o RPC deixava passar.
    await expect(
      comoPapel("service_role", null, (c) => c.query(RPC, [a.org, passado, {}, tok])),
    ).rejects.toMatchObject({ code: "22023", message: "attendance_status_invalid" });
    const futuro = await compromisso(a, "now()+interval '1 day'");
    await expect(
      comoPapel("service_role", null, (c) => c.query(RPC, [a.org, futuro, { status: "completed" }, tok])),
    ).rejects.toMatchObject({ code: "22023", message: "appointment_not_started" });
    expect(await estado(passado)).toEqual(INTOCADO);
    expect(await estado(futuro)).toEqual(INTOCADO);
  });

  it("GUC forjada sem o RPC não autoriza: o gatilho revalida organização e escopo do token", async () => {
    const [a, b] = [tenants[0]!, tenants[1]!];
    const forjas = [await token(b, ["agenda:attendance"]), await token(a, ["mcp:write"]), randomUUID()];
    for (const forja of forjas) {
      const id = await compromisso(a);
      await expect(
        comoPapel("service_role", null, async (c) => {
          await c.query("select set_config('agenda.attendance_token',$1,true)", [forja]);
          return c.query(CHANGE, [a.org, id, { status: "completed" }]);
        }),
      ).rejects.toMatchObject({ code: "42501", message: "appointment_human_confirmation_required" });
      expect(await estado(id)).toEqual(INTOCADO);
    }
  });

  it("sessão comum e anon não executam o RPC, e a GUC não amplia quem tem auth.uid()", async () => {
    const a = tenants[0]!;
    const tok = await token(a, ["mcp:write", "agenda:attendance"]);
    const id = await compromisso(a);
    for (const [role, user] of [
      ["authenticated", a.manager],
      ["anon", null],
    ] as const) {
      await expect(
        comoPapel(role, user, (c) => c.query(RPC, [a.org, id, { status: "completed" }, tok])),
      ).rejects.toMatchObject({ code: "42501" });
    }
    // O viewer com a GUC de um token válido segue o caminho de PESSOA, que o recusa.
    await expect(
      comoPapel("authenticated", a.viewer, async (c) => {
        await c.query("select set_config('agenda.attendance_token',$1,true)", [tok]);
        return c.query(CHANGE, [a.org, id, { status: "completed" }]);
      }),
    ).rejects.toMatchObject({ code: "42501" });
    expect(await estado(id)).toEqual(INTOCADO);
  });

  it("compromisso de autoridade externa (9392) não recebe comparecimento por token", async () => {
    // O RPC roda como servidor; sem a recusa, o carimbo cairia no ramo do
    // espelho e devolveria sucesso sem gravar o token que registrou.
    const a = tenants[0]!;
    const tok = await token(a, ["mcp:write", "agenda:attendance"]);
    const id = await compromisso(a);
    await pool.query(
      "update calendar_appointments set authority='amigo', external_connection_id=gen_random_uuid() where id=$1",
      [id],
    );
    await expect(
      comoPapel("service_role", null, (c) => c.query(RPC, [a.org, id, { status: "completed" }, tok])),
    ).rejects.toMatchObject({ code: "42501", message: "attendance_external_authority" });
    expect(await estado(id)).toEqual(INTOCADO);
  });
});
