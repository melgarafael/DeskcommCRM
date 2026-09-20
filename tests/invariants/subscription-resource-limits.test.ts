import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { sql } from "./gov-helpers";
import { SUBSCRIPTION_PLANS } from "../../lib/billing/plans";
const exec = promisify(execFile);
function company(paid = true) {
  const org = randomUUID();
  sql(
    `insert into organizations(id,slug,legal_name,display_name) values('${org}','quota-${org}','Quota','Quota');`,
  );
  if (paid)
    sql(
      `insert into org_subscriptions(organization_id,plan_id,provider_subscription_id,status,current_period_end) values('${org}','essencial','sub_${org.replaceAll("-", "")}','active',now()+interval '1 month');`,
    );
  return org;
}
function addAgent(org: string) {
  return `insert into ai_agents(organization_id,name,system_prompt) values('${org}','Quota '||gen_random_uuid()::text,'Synthetic test')`;
}
it("database capacities match the public catalogue", () => {
  for (const p of SUBSCRIPTION_PLANS)
    expect(
      sql(
        `select seats||','||channels||','||agents from subscription_plan_limits where plan_id='${p.id}'`,
      ),
    ).toBe(`${p.seats},${p.channels},${p.agents}`);
});
it("blocks a third agent and releases the slot only on explicit archive", () => {
  const org = company();
  sql(`${addAgent(org)};${addAgent(org)};`);
  expect(() => sql(addAgent(org))).toThrow(/limite de agentes/);
  sql(
    `update ai_agents set archived_at=now() where id=(select id from ai_agents where organization_id='${org}' limit 1)`,
  );
  sql(addAgent(org));
  expect(
    sql(`select count(*) from ai_agents where organization_id='${org}' and archived_at is null`),
  ).toBe("2");
  expect(() =>
    sql(
      `update ai_agents set archived_at=null where organization_id='${org}' and archived_at is not null`,
    ),
  ).toThrow(/limite de agentes/);
});
it("legacy resources survive subscription and downgrade without allowing new additions", () => {
  const org = company(false);
  for (let i = 0; i < 4; i++) sql(addAgent(org));
  sql(
    `insert into org_subscriptions(organization_id,plan_id,provider_subscription_id,status,current_period_end) values('${org}','essencial','sub_${org.replaceAll("-", "")}','active',now()+interval '1 month');update ai_agents set name='Preserved '||id::text where organization_id='${org}';`,
  );
  expect(sql(`select count(*) from ai_agents where organization_id='${org}'`)).toBe("4");
  expect(() => sql(addAgent(org))).toThrow(/limite de agentes/);
});
it("pending checkout does not convert an existing company", () => {
  const org = company(false);
  sql(`insert into org_subscriptions(organization_id,plan_id) values('${org}','essencial')`);
  for (let i = 0; i < 4; i++) sql(addAgent(org));
  expect(sql(`select count(*) from ai_agents where organization_id='${org}'`)).toBe("4");
});
it("canceled subscriptions preserve editing but block additions", () => {
  const org = company();
  sql(addAgent(org));
  sql(`update org_subscriptions set status='canceled' where organization_id='${org}'`);
  sql(`update ai_agents set name='Still accessible' where organization_id='${org}'`);
  expect(() => sql(addAgent(org))).toThrow(/Regularize sua assinatura/);
});
it("unarchived channels reserve slots even while disconnected", () => {
  const org = company();
  const insert = `insert into channel_sessions(organization_id,waha_session_name,status,webhook_secret_encrypted) values('${org}',gen_random_uuid()::text,'STOPPED',decode('00','hex'))`;
  sql(insert);
  expect(() => sql(insert)).toThrow(/limite de canais/);
});
it("membership records reserve seats and revocation releases capacity", () => {
  const org = company();
  const members = [randomUUID(), randomUUID(), randomUUID()] as const;
  for (const id of members)
    sql(`insert into auth.users(id,email) values('${id}','${id}@invariant.test')`);
  const invite = (id: string) =>
    `insert into user_organizations(user_id,organization_id,role) values('${id}','${org}','agent')`;
  sql(invite(members[0]));
  sql(invite(members[1]));
  expect(() => sql(invite(members[2]))).toThrow(/limite de pessoas/);
  sql(
    `update user_organizations set revoked_at=now() where user_id='${members[0]}' and organization_id='${org}'`,
  );
  sql(invite(members[2]));
});
it("concurrent inserts cannot take the same last slot", async () => {
  const org = company();
  sql(addAgent(org));
  const run = () =>
    exec("docker", [
      "exec",
      process.env.TEST_DB_CONTAINER!,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      `begin;${addAgent(org)};select pg_sleep(0.3);commit;`,
    ]);
  const results = await Promise.allSettled([run(), run()]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(sql(`select count(*) from ai_agents where organization_id='${org}'`)).toBe("2");
});
it("catalogue and trigger are not tenant-writable or callable", () => {
  expect(
    sql(
      `select has_table_privilege('authenticated','public.subscription_plan_limits','INSERT,UPDATE,DELETE')`,
    ),
  ).toBe("f");
  expect(
    sql(
      `select has_function_privilege('authenticated','public.fn_subscription_resource_limit()','EXECUTE')`,
    ),
  ).toBe("f");
});
it("migration reapplication preserves existing resources", () => {
  const org = company();
  sql(addAgent(org));
  sql(
    readFileSync(
      "supabase/migrations/20260920072058_0315_subscription_resource_limits.sql",
      "utf8",
    ),
  );
  expect(sql(`select count(*) from ai_agents where organization_id='${org}'`)).toBe("1");
});
it("one company at capacity cannot consume another company's quota", () => {
  const a = company(),
    b = company();
  sql(`${addAgent(a)};${addAgent(a)};`);
  sql(addAgent(b));
  expect(sql(`select count(*) from ai_agents where organization_id='${b}'`)).toBe("1");
});
it("resource reservations do not extend the ambiguous checkout retry clock", () => {
  const org = company();
  const before = sql(`select updated_at from org_subscriptions where organization_id='${org}'`);
  sql(addAgent(org));
  expect(sql(`select updated_at from org_subscriptions where organization_id='${org}'`)).toBe(
    before,
  );
  expect(sql(`select quota_revision from org_subscriptions where organization_id='${org}'`)).toBe(
    "1",
  );
});
it("repeatable-read transactions cannot bypass the last-slot fence", async () => {
  const org = company();
  sql(addAgent(org));
  const run = () =>
    exec("docker", [
      "exec",
      process.env.TEST_DB_CONTAINER!,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      `begin isolation level repeatable read;select count(*) from ai_agents where organization_id='${org}';select pg_sleep(0.3);${addAgent(org)};select pg_sleep(0.3);commit;`,
    ]);
  const results = await Promise.allSettled([run(), run()]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(sql(`select count(*) from ai_agents where organization_id='${org}'`)).toBe("2");
});
