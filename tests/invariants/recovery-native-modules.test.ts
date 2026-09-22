import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";
const sql = (query: string) => execFileSync("docker", ["exec", "-i", process.env.TEST_DB_CONTAINER!, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA"], { input: query, encoding: "utf8" }).trim();
const org = "c0323000-0000-4000-8000-000000000001";
const other = "c0323000-0000-4000-8000-000000000002";
const admin = "c0323000-0000-4000-8000-000000000003";
const stranger = "c0323000-0000-4000-8000-000000000004";
const viewer = "c0323000-0000-4000-8000-000000000005";
const asUser = (id: string, query: string) => sql(`set role authenticated; select set_config('request.jwt.claims','{"sub":"${id}"}',false);${query}`).split("\n").at(-1);
beforeAll(() => {
 sql(`insert into auth.users(id,email) values('${admin}','recovery-admin@test.invalid'),('${stranger}','recovery-other@test.invalid'),('${viewer}','recovery-viewer@test.invalid');
 insert into organizations(id,slug,legal_name,display_name) values('${org}','recovery-a','Recovery A','Recovery A'),('${other}','recovery-b','Recovery B','Recovery B');
 insert into user_organizations(user_id,organization_id,role,accepted_at) values('${admin}','${org}','admin',now()),('${stranger}','${other}','admin',now()),('${viewer}','${org}','viewer',now());
 insert into growth_instagram_triggers(organization_id,name,dm_response_template) values('${org}','Teste isolado','Resposta');
 insert into audit_mystery_scenarios(organization_id,title,persona_name,persona_description,objective) values('${org}','Teste isolado','Pessoa','Descrição','Objetivo');
 insert into audit_mystery_executions(organization_id,scenario_id) select organization_id,id from audit_mystery_scenarios where organization_id='${org}';`);
});
describe("recovered native modules", () => {
 for (const table of ["growth_instagram_triggers", "audit_mystery_scenarios", "audit_mystery_executions"]) {
  it(`${table}: admin sees own data, another company and viewer do not`, () => {
   expect(asUser(admin,`select count(*) from ${table}`)).toBe("1");
   expect(asUser(stranger,`select count(*) from ${table}`)).toBe("0");
   expect(asUser(viewer,`select count(*) from ${table}`)).toBe("0");
   expect(sql(`select has_table_privilege('anon','${table}','SELECT')`)).toBe("f");
  });
 }
 it("new modules coexist with restored billing, Instagram and voice tables", () => {
  expect(sql("select (to_regclass('public.org_subscriptions') is not null and to_regclass('public.voice_missions') is not null)::text")).toBe("true");
 });
});
