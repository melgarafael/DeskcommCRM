import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { seedGov, GOV_AGENT_A, GOV_AGENT_B, GOV_VIEWER } from "./gov-helpers";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 4,
});
const orgA = randomUUID(),
  orgB = randomUUID();
async function fixture(org: string, owner: string | null) {
  const id = randomUUID(),
    conn = randomUUID(),
    cal = randomUUID();
  if (owner) {
    await pool.query(
      "insert into calendar_connections(id,organization_id,user_id,provider,account_email,status) values($1,$2,$3,'google_calendar',$4,'healthy')",
      [conn, org, owner, `${conn}@invariant.test`],
    );
    await pool.query(
      "insert into calendar_connection_calendars(id,organization_id,connection_id,external_calendar_id,name,is_destination,counts_for_conflicts,access_role) values($1,$2,$3,'local','Local',true,true,'owner')",
      [cal, org, conn],
    );
  }
  await pool.query(
    "insert into calendar_appointments(id,organization_id,owner_user_id,title,starts_at,ends_at,google_next_attempt_at) values($1,$2,$3,'Local',now()+interval '3 days',now()+interval '3 days 1 hour',now()+interval '1 day')",
    [id, org, owner],
  );
  return { id, conn, cal, org, owner };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
let a: Fixture, b: Fixture, otherOwner: Fixture, unowned: Fixture;
beforeAll(async () => {
  await seedGov();
  for (const org of [orgA, orgB])
    await pool.query(
      "insert into organizations(id,slug,display_name,legal_name) values($1,$2,'ACL Google','ACL Google')",
      [org, `google-acl-${org}`],
    );
  for (const [org, user, role] of [
    [orgA, GOV_AGENT_A, "agent"],
    [orgA, GOV_AGENT_B, "agent"],
    [orgA, GOV_VIEWER, "viewer"],
    [orgB, GOV_AGENT_B, "agent"],
  ]) {
    await pool.query(
      "insert into user_organizations(organization_id,user_id,role,accepted_at) values($1,$2,$3,now())",
      [org, user, role],
    );
  }
  a = await fixture(orgA, GOV_AGENT_A);
  b = await fixture(orgB, GOV_AGENT_B);
  otherOwner = await fixture(orgA, GOV_AGENT_B);
  unowned = await fixture(orgA, null);
});
afterAll(() => pool.end());
async function asActor(
  user: string | null,
  statement: string,
  args: unknown[],
  sameTransactionDue?: string,
  aal = "aal1",
) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    // Precondição exata: now() é estável na transação. Sem dono, o ramo antigo
    // passava pelo IF NULL e aceitava um retry de prazo já igual a now().
    if (sameTransactionDue)
      await client.query(
        "update calendar_appointments set google_next_attempt_at=now() where id=$1",
        [sameTransactionDue],
      );
    await client.query(user ? "set local role authenticated" : "set local role anon");
    await client.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify(user ? { sub: user, role: "authenticated", aal } : { role: "anon" }),
    ]);
    const result = await client.query(statement, args);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
async function revisions(org: string, owner: string) {
  return JSON.stringify(
    (
      await pool.query(
        "select id connection_id,calendar_selection_revision::text revision from calendar_connections where organization_id=$1 and user_id=$2 order by id",
        [org, owner],
      )
    ).rows,
  );
}
async function snapshot() {
  const result = await pool.query(
    "select jsonb_build_object('appointments',(select jsonb_agg(to_jsonb(a) order by id) from calendar_appointments a where organization_id=any($1::uuid[])),'calendars',(select jsonb_agg(to_jsonb(k) order by id) from calendar_connection_calendars k where organization_id=any($1::uuid[])),'connections',(select jsonb_agg(to_jsonb(c) order by id) from calendar_connections c where organization_id=any($1::uuid[]))) state",
    [[orgA, orgB]],
  );
  return result.rows[0].state;
}
const selection = "select fn_google_selection($1,$2,$3,$4)";
const resolve = "select fn_google_resolve($1,$2,'1','1',null,'retry')";
it("MFA da seleção mantém sem fator permitido e exige aal2 depois do cadastro verificado", async () => {
  const factor = randomUUID();
  await asActor(a.owner, selection, [a.org, await revisions(a.org, a.owner!), [a.cal], a.cal]);
  await pool.query("insert into auth.mfa_factors(id,user_id,status,factor_type) values($1,$2,'verified','totp')", [factor, a.owner]);
  try {
    const args = [a.org, await revisions(a.org, a.owner!), [], a.cal];
    const before = await snapshot();
    await expect(asActor(a.owner, selection, args, undefined, "aal1")).rejects.toMatchObject({ code: "42501" });
    expect(await snapshot()).toEqual(before);
    await asActor(a.owner, selection, args, undefined, "aal2");
    expect((await pool.query("select counts_for_conflicts from calendar_connection_calendars where id=$1", [a.cal])).rows[0].counts_for_conflicts).toBe(false);
    expect(await revisions(a.org, a.owner!)).not.toBe(args[1]);
  } finally { await pool.query("delete from auth.mfa_factors where id=$1", [factor]); }
});

it.each(["retry", "local"])("MFA da resolução %s nega sem efeito e aceita o mesmo fator com aal2", async choice => {
  const f = await fixture(orgA, GOV_AGENT_A), factor = randomUUID();
  await asActor(f.owner, resolve, [f.org, f.id]);
  // Monta um conflito real com as revisões e a projeção esperadas pelo trigger.
  const conflict = { revision: "1", local_revision: "1", etag: "remote", remote: { title: "Remoto", starts_at: "2030-01-01T12:00:00Z", ends_at: "2030-01-01T13:00:00Z", time_zone: "UTC", status: "confirmed" } };
  if (choice !== "retry") await pool.query("update calendar_appointments set google_conflict=$2,google_etag='remote' where id=$1", [f.id, conflict]);
  await pool.query("update calendar_appointments set google_next_attempt_at=now()+interval '1 day' where id=$1", [f.id]);
  const query = "select fn_google_resolve($1,$2,'1','1',$3,$4)";
  const args = [f.org, f.id, choice === "retry" ? null : "remote", choice];
  await pool.query("insert into auth.mfa_factors(id,user_id,status,factor_type) values($1,$2,'verified','totp')", [factor, f.owner]);
  try {
    const before = await snapshot();
    await expect(asActor(f.owner, query, args, undefined, "aal1")).rejects.toMatchObject({ code: "42501" });
    expect(await snapshot()).toEqual(before);
    await asActor(f.owner, query, args, undefined, "aal2");
    const after = (await pool.query("select google_next_attempt_at<=now() due,google_conflict from calendar_appointments where id=$1", [f.id])).rows[0];
    expect(after.due).toBe(true);
    if (choice === "local") expect(after.google_conflict.resolution).toEqual({ choice, actor_id: f.owner });
  } finally { await pool.query("delete from auth.mfa_factors where id=$1", [factor]); }
});

it.each(["A", "B"])("agent dono %s seleciona e rearma pela própria sessão", async (which) => {
  const f = which === "A" ? a : b;
  await asActor(f.owner, selection, [f.org, await revisions(f.org, f.owner!), [], f.cal]);
  expect(
    (
      await pool.query(
        "select counts_for_conflicts from calendar_connection_calendars where id=$1",
        [f.cal],
      )
    ).rows[0].counts_for_conflicts,
  ).toBe(false);
  await asActor(f.owner, resolve, [f.org, f.id]);
  expect(
    (
      await pool.query(
        "select google_next_attempt_at<=now() due from calendar_appointments where id=$1",
        [f.id],
      )
    ).rows[0].due,
  ).toBe(true);
});
it.each(["viewer", "cross_org", "other_owner", "anon"])(
  "selection recusa %s sem efeito",
  async (kind) => {
    const user = kind === "anon" ? null : kind === "viewer" ? GOV_VIEWER : GOV_AGENT_A;
    const org = kind === "cross_org" ? orgB : orgA;
    const target = kind === "cross_org" ? b : kind === "other_owner" ? otherOwner : a;
    const before = await snapshot();
    await expect(
      asActor(user, selection, [org, await revisions(org, GOV_AGENT_A), [], target.cal]),
    ).rejects.toMatchObject({ code: "42501" });
    expect(await snapshot()).toEqual(before);
  },
);
it.each(["viewer", "cross_org", "other_owner", "anon"])(
  "resolve recusa %s sem efeito",
  async (kind) => {
    const user = kind === "anon" ? null : kind === "viewer" ? GOV_VIEWER : GOV_AGENT_A;
    const target = kind === "cross_org" ? b : kind === "other_owner" ? otherOwner : a;
    const before = await snapshot();
    await expect(asActor(user, resolve, [target.org, target.id])).rejects.toMatchObject({
      code: "42501",
    });
    expect(await snapshot()).toEqual(before);
  },
);
it.each([false, true])(
  "resolve exige dono não nulo, mesmo prazo já igual à transação=%s",
  async (sameDue) => {
    const before = await snapshot();
    await expect(
      asActor(GOV_AGENT_A, resolve, [orgA, unowned.id], sameDue ? unowned.id : undefined),
    ).rejects.toThrow("google_resolution_forbidden");
    expect(await snapshot()).toEqual(before);
  },
);
