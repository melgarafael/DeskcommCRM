import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
});
const tenants = [0, 1].map(() => ({
  org: randomUUID(),
  manager: randomUUID(),
  agent: randomUUID(),
  viewer: randomUUID(),
}));
type Tenant = (typeof tenants)[number];

// Cada probe usa uma conexão/transação própria: uma negação real não contamina
// o positivo seguinte, e nenhum JWT vaza para outro papel no pool.
async function asRole(
  role: "anon" | "authenticated" | "service_role",
  user: string | null,
  query: string,
  values: unknown[] = [],
  aal = "aal1",
) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`set local role ${role}`);
    await client.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ role, aal, ...(user ? { sub: user } : {}) }),
    ]);
    const result = await client.query(query, values);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
beforeAll(async () => {
  for (const tenant of tenants) {
    await pool.query(
      "insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'ACL agenda','ACL agenda')",
      [tenant.org],
    );
    for (const role of ["manager", "agent", "viewer"] as const) {
      const user = tenant[role];
      await pool.query("insert into auth.users(id,email) values($1,$2)", [
        user,
        `${user}@invariant.test`,
      ]);
      await pool.query(
        "insert into user_organizations(user_id,organization_id,role,accepted_at) values($1,$2,$3,now())",
        [user, tenant.org, role],
      );
    }
  }
});
afterAll(() => pool.end());

async function appointment(tenant: Tenant) {
  const contact = randomUUID(),
    id = randomUUID();
  await pool.query(
    "insert into contacts(id,organization_id,display_name) values($1,$2,'ACL presença')",
    [contact, tenant.org],
  );
  await pool.query(
    "insert into calendar_appointments(id,organization_id,contact_id,title,starts_at,ends_at,status) values($1,$2,$3,'ACL presença',now()-interval '2 hours',now()-interval '1 hour','confirmed')",
    [id, tenant.org, contact],
  );
  return id;
}
const changeQuery = "select fn_appointment_change($1,$2,1,$3) result";
const settingsQuery = "select fn_agenda_settings($1,$2) result";
const recoverQuery = "select fn_appointment_recover($1,$2) result";

describe("agenda: superfícies humanas e recibo privado têm autorização comportamental", () => {
  it("MFA direto de presença exige prova do fator e preserva o caller service_role", async () => {
    const tenant = tenants[0]!;
    const args = [tenant.org, await appointment(tenant), { status: "no_show" }];
    await asRole("authenticated", tenant.agent, changeQuery, args);
    const id = await appointment(tenant), factor = randomUUID();
    const snapshot = async () => (await pool.query("select jsonb_build_object('appointment',(select to_jsonb(a) from calendar_appointments a where id=$1),'events',(select jsonb_agg(to_jsonb(e)) from event_log e where entity_id=$1),'notices',(select jsonb_agg(to_jsonb(n)) from agent_inbox_items n where ref_id=$1)) state", [id])).rows[0].state;
    await pool.query("insert into auth.mfa_factors(id,user_id,status,factor_type) values($1,$2,'verified','totp')", [factor, tenant.agent]);
    try {
      const before = await snapshot();
      await expect(asRole("authenticated", tenant.agent, changeQuery, [tenant.org, id, { status: "no_show" }], "aal1")).rejects.toMatchObject({ code: "42501" });
      expect(await snapshot()).toEqual(before);
      const allowed = await asRole("authenticated", tenant.agent, changeQuery, [tenant.org, id, { status: "no_show" }], "aal2");
      expect(allowed.rows[0].result).toMatchObject({ status: "no_show", outcome_user_id: tenant.agent, revision: 2 });
      const internal = await asRole("service_role", null, changeQuery, [tenant.org, await appointment(tenant), { status: "cancelled" }]);
      expect(internal.rows[0].result.status).toBe("cancelled");
    } finally { await pool.query("delete from auth.mfa_factors where id=$1", [factor]); }
  });

  it("MFA direto de settings distingue sem fator, fator aal1 e mesmo fator aal2", async () => {
    const tenant = tenants[0]!, factor = randomUUID();
    const config = { confirmation_delay_minutes: 17, unknown_protection_minutes: 130 };
    await asRole("authenticated", tenant.manager, settingsQuery, [tenant.org, config]);
    await pool.query("insert into auth.mfa_factors(id,user_id,status,factor_type) values($1,$2,'verified','totp')", [factor, tenant.manager]);
    const next = { confirmation_delay_minutes: 18, unknown_protection_minutes: 140 };
    try {
      const before = (await pool.query("select settings from organizations where id=$1", [tenant.org])).rows[0].settings;
      await expect(asRole("authenticated", tenant.manager, settingsQuery, [tenant.org, next], "aal1")).rejects.toMatchObject({ code: "42501" });
      expect((await pool.query("select settings from organizations where id=$1", [tenant.org])).rows[0].settings).toEqual(before);
      expect((await asRole("authenticated", tenant.manager, settingsQuery, [tenant.org, next], "aal2")).rows[0].result).toEqual(next);
      expect((await pool.query("select settings->'agenda' config from organizations where id=$1", [tenant.org])).rows[0].config).toEqual(next);
    } finally { await pool.query("delete from auth.mfa_factors where id=$1", [factor]); }
  });

  it("RPC de presença exige JWT com papel e org próprios, nos dois sentidos A/B, e preserva autoria humana", async () => {
    for (const tenant of tenants) {
      const other = tenants.find((t) => t.org !== tenant.org)!;
      const id = await appointment(tenant);
      const args = [tenant.org, id, { status: "no_show", outcome_user_id: other.manager }];
      for (const user of [tenant.viewer, other.agent, other.manager]) {
        await expect(asRole("authenticated", user, changeQuery, args)).rejects.toMatchObject({
          code: "42501",
        });
      }
      await expect(asRole("anon", null, changeQuery, args)).rejects.toMatchObject({
        code: "42501",
      });
      expect(
        (
          await pool.query(
            "select status,revision,outcome_user_id from calendar_appointments where id=$1",
            [id],
          )
        ).rows[0],
      ).toEqual({ status: "confirmed", revision: "1", outcome_user_id: null });
      const result = (await asRole("authenticated", tenant.agent, changeQuery, args)).rows[0]
        .result;
      expect(result).toMatchObject({
        id,
        organization_id: tenant.org,
        status: "no_show",
        revision: 2,
        outcome_user_id: tenant.agent,
      });
      // Mesmo usuário autorizado não transforma id da outra org em entidade própria.
      await expect(
        asRole("authenticated", tenant.agent, changeQuery, [
          tenant.org,
          await appointment(other),
          { status: "no_show" },
        ]),
      ).rejects.toMatchObject({ code: "P0002" });
    }
  });

  it("RPC dos prazos aceita manager da própria org; agent/viewer, manager vizinho e anon não escrevem", async () => {
    for (const tenant of tenants) {
      const other = tenants.find((t) => t.org !== tenant.org)!;
      const config = { confirmation_delay_minutes: 15, unknown_protection_minutes: 120 };
      const before = (
        await pool.query("select settings from organizations where id=$1", [tenant.org])
      ).rows[0].settings;
      for (const user of [tenant.agent, tenant.viewer, other.manager]) {
        await expect(
          asRole("authenticated", user, settingsQuery, [tenant.org, config]),
        ).rejects.toMatchObject({ code: "42501" });
      }
      await expect(asRole("anon", null, settingsQuery, [tenant.org, config])).rejects.toMatchObject(
        { code: "42501" },
      );
      await expect(
        asRole("service_role", null, settingsQuery, [tenant.org, config]),
      ).rejects.toMatchObject({ code: "42501" });
      expect(
        (await pool.query("select settings from organizations where id=$1", [tenant.org])).rows[0]
          .settings,
      ).toEqual(before);
      expect(
        (await asRole("authenticated", tenant.manager, settingsQuery, [tenant.org, config])).rows[0]
          .result,
      ).toEqual(config);
      expect(
        (
          await pool.query("select settings->'agenda' agenda from organizations where id=$1", [
            tenant.org,
          ])
        ).rows[0].agenda,
      ).toEqual(config);
    }
  });

  it("recuperação service-only rejeita tupla cruzada A/B antes e depois do recibo; operação válida cria uma decisão própria", async () => {
    const sources: { org: string; id: string; event: string }[] = [];
    for (const tenant of tenants) {
      const id = await appointment(tenant);
      await asRole("authenticated", tenant.agent, changeQuery, [
        tenant.org,
        id,
        { status: "no_show" },
      ]);
      const event = (
        await pool.query(
          "select id from event_log where organization_id=$1 and entity_id=$2 and event_type='appointment.outcome_confirmed'",
          [tenant.org, id],
        )
      ).rows[0].id as string;
      sources.push({ org: tenant.org, id, event });
    }
    for (const source of sources) {
      const other = sources.find((s) => s.org !== source.org)!;
      for (const tenant of tenants) {
        await expect(
          asRole("authenticated", tenant.manager, recoverQuery, [source.org, source.event]),
        ).rejects.toMatchObject({ code: "42501" });
      }
      await expect(
        asRole("anon", null, recoverQuery, [source.org, source.event]),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        asRole("service_role", null, recoverQuery, [other.org, source.event]),
      ).rejects.toMatchObject({ code: "P0002" });
      expect(
        (
          await pool.query(
            "select count(*)::int n from appointment_recovery_receipts where appointment_id=$1",
            [source.id],
          )
        ).rows[0].n,
      ).toBe(0);
      const result = (await asRole("service_role", null, recoverQuery, [source.org, source.event]))
        .rows[0].result;
      expect(result).toMatchObject({
        organization_id: source.org,
        appointment_id: source.id,
        appointment_revision: 2,
        source_event_id: source.event,
        result: "not_configured",
      });
      expect(
        (await asRole("service_role", null, recoverQuery, [source.org, source.event])).rows[0]
          .result,
      ).toEqual(result);
      await expect(
        asRole("service_role", null, recoverQuery, [other.org, source.event]),
      ).rejects.toMatchObject({ code: "P0002" });
      expect(
        (
          await asRole(
            "service_role",
            null,
            "select organization_id,appointment_id from appointment_recovery_receipts where organization_id=$1",
            [source.org],
          )
        ).rows,
      ).toEqual([{ organization_id: source.org, appointment_id: source.id }]);

      const writes = [
        [
          "insert into appointment_recovery_receipts(organization_id,appointment_id,appointment_revision,result) values($1,$2,999,'stale')",
          [source.org, source.id],
        ],
        [
          "update appointment_recovery_receipts set result='stale' where appointment_id=$1",
          [source.id],
        ],
        ["delete from appointment_recovery_receipts where appointment_id=$1", [source.id]],
        ["truncate appointment_recovery_receipts", []],
      ] as const;
      for (const [role, user] of [
        ["anon", null],
        ["authenticated", tenants[0]!.manager],
        ["authenticated", tenants[1]!.manager],
        ["service_role", null],
      ] as const) {
        if (role !== "service_role") {
          await expect(
            asRole(
              role,
              user,
              "select * from appointment_recovery_receipts where appointment_id=$1",
              [source.id],
            ),
          ).rejects.toMatchObject({ code: "42501" });
        }
        for (const [query, values] of writes) {
          await expect(asRole(role, user, query, [...values])).rejects.toMatchObject({
            code: "42501",
          });
        }
      }
      expect(
        (await asRole("service_role", null, recoverQuery, [source.org, source.event])).rows[0]
          .result,
      ).toEqual(result);
    }
    expect(
      (await pool.query("select count(*)::int n from appointment_recovery_receipts")).rows[0].n,
    ).toBe(2);
  });
});
