/**
 * New invariant for the installation-level presentation default. Existing frozen laws stay intact.
 * Covers the new platform authority/ACL, atomic provisioning and preservation of tenant choices.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
if (!process.env.TEST_DB_CONTAINER) throw new Error("Use pnpm test:db");
const pool = new pg.Pool({
  connectionString: process.env.TEST_DB_URL ?? `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 4,
});
const admin = randomUUID(), tenantAdmin = randomUUID(), readonly = randomUUID(), revoked = randomUUID();
const existing = randomUUID(), catalog = "a".repeat(64);
async function org(id = randomUUID()) {
  await pool.query("insert into organizations(id,slug,legal_name,display_name,settings) values($1::uuid,$1::text,'Teste','Teste',$2)",
    [id, { branding: { accent_hex: "#123456" }, retained: true }]);
  return id;
}
async function apply(args: { actor?: string; revision?: number; request?: string; theme?: string; values?: unknown } = {}) {
  return (await pool.query("select fn_ui_theme_initial_default_apply($1,$2,$3,$4,1,$5,$6,$7) result", [
    args.actor ?? admin, args.theme ?? "demo", args.theme === "padrao" ? "builtin-padrao-v1" : "demo-install-1",
    catalog, args.values ?? { "global.spacing": "wide" }, args.revision ?? 0, args.request ?? randomUUID(),
  ])).rows[0].result;
}
beforeAll(async () => {
  for (const id of [admin, tenantAdmin, readonly, revoked])
    await pool.query("insert into auth.users(id,email) values($1,$2)", [id, `${id}@example.test`]);
  await pool.query("insert into platform_admins(user_id,scope,mfa_required,granted_by,reason) values($1,'full',false,$1,'Fixture TM011'),($2,'support_readonly',false,$1,'Fixture TM011'),($3,'full',false,$1,'Fixture TM011')", [admin, readonly, revoked]);
  await pool.query("update platform_admins set revoked_at=now() where user_id=$1", [revoked]);
  await org(existing);
  await pool.query("insert into user_organizations(user_id,organization_id,role,accepted_at) values($1,$2,'admin',now())", [tenantAdmin, existing]);
});
beforeEach(async () => {
  await pool.query("delete from platform_ui_theme_defaults");
  await pool.query("update platform_admins set revoked_at=null,scope='full' where user_id=$1", [admin]);
});
afterAll(() => pool.end());

describe("tema inicial de novas organizações", () => {
  it("sem escolha global preserva o Padrão e não grava estado visual artificial", async () => {
    const id = await org();
    expect((await pool.query("select theme_id from organization_ui_themes where organization_id=$1", [id])).rows).toEqual([]);
    expect((await pool.query("select action from api_audit_log where organization_id=$1 and action='ui_theme.updated'", [id])).rows).toEqual([]);
  });
  it("copia só o tema/opções ativos na mesma criação e audita a origem sem dados empresariais", async () => {
    await apply();
    const id = await org();
    const row = (await pool.query("select theme_id,revision,configurations,updated_by from organization_ui_themes where organization_id=$1", [id])).rows[0];
    expect(row).toEqual({ theme_id: "demo", revision: 1, updated_by: null,
      configurations: { demo: { version: 1, values: { "global.spacing": "wide" } } } });
    const audit = (await pool.query("select actor_user_id,metadata from api_audit_log where organization_id=$1 and action='ui_theme.updated'", [id])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_user_id: null, metadata: { source: "installation_initial_default", initial_default_revision: 1, options_version: 1 } });
    expect(audit[0].metadata).not.toHaveProperty("values");
    expect((await pool.query("select settings from organizations where id=$1", [id])).rows[0].settings).toEqual(
      (await pool.query("select settings from organizations where id=$1", [existing])).rows[0].settings,
    );
  });
  it("mudar o padrão só afeta criações seguintes e não carrega opções inativas", async () => {
    await apply();const first = await org();
    await apply({ revision: 1, theme: "padrao", values: {} });const next = await org();
    expect((await pool.query("select theme_id from organization_ui_themes where organization_id=$1", [first])).rows[0].theme_id).toBe("demo");
    expect((await pool.query("select theme_id,configurations from organization_ui_themes where organization_id=$1", [next])).rows[0])
      .toEqual({ theme_id: "padrao", configurations: { padrao: { version: 1, values: {} } } });
    expect((await pool.query("select theme_id from organization_ui_themes where organization_id=$1", [existing])).rows).toEqual([]);
  });
  it("o administrador do novo tenant pode trocar depois e outra mudança global não sobrescreve", async () => {
    await apply();const id = await org();
    await pool.query("insert into user_organizations(user_id,organization_id,role,accepted_at) values($1,$2,'admin',now())", [tenantAdmin, id]);
    await pool.query("select fn_ui_theme_apply($1,$2,'padrao','builtin-padrao-v1',$3,1,'{}',1,$4)", [id, tenantAdmin, catalog, randomUUID()]);
    await apply({ revision: 1, values: { "global.spacing": "normal" } });
    expect((await pool.query("select theme_id,revision from organization_ui_themes where organization_id=$1", [id])).rows[0]).toEqual({ theme_id: "padrao", revision: 2 });
  });
  it("pedido idêntico é idempotente e conteúdo/revisão concorrentes são recusados", async () => {
    const request = randomUUID();await apply({ request });
    expect(await apply({ request })).toEqual({ revision: 1, applied_now: false });
    await expect(apply({ request, values: { "global.spacing": "normal" } })).rejects.toMatchObject({ code: "PT409" });
    await expect(apply()).rejects.toMatchObject({ code: "PT409" });
    const audit = (await pool.query("select organization_id,resource_id,actor_user_id,metadata from api_audit_log where action='ui_theme.initial_default_updated' and request_id=$1", [request])).rows;
    expect(audit).toHaveLength(1);expect(audit[0]).toMatchObject({ organization_id: null, resource_id: null, actor_user_id: admin });
    expect(audit[0].metadata).not.toHaveProperty("values");
  });
  it("duas primeiras gravações têm uma única vencedora", async () => {
    const results = await Promise.allSettled([apply(), apply({ values: { "global.spacing": "normal" } })]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find(r => r.status === "rejected")).toMatchObject({ reason: { code: "PT409" } });
  });
  it("admin de tenant, suporte e platform admin revogado não definem o padrão", async () => {
    for (const actor of [tenantAdmin, readonly, revoked]) await expect(apply({ actor })).rejects.toMatchObject({ code: "42501" });
    expect((await pool.query("select id from platform_ui_theme_defaults")).rows).toEqual([]);
  });
  it("revogação também impede repetição de um recibo anteriormente válido", async () => {
    const request = randomUUID();await apply({ request });
    await pool.query("update platform_admins set revoked_at=now() where user_id=$1", [admin]);
    await expect(apply({ request })).rejects.toMatchObject({ code: "42501" });
  });
  it("ACL não expõe singleton/RPC a anon ou authenticated, nem escrita direta a service_role", async () => {
    for (const role of ["anon", "authenticated"]) {
      const permissions = (await pool.query("select has_table_privilege($1,'public.platform_ui_theme_defaults','select') can_read, has_table_privilege($1,'public.platform_ui_theme_defaults','insert,update,delete') can_write, has_function_privilege($1,'public.fn_ui_theme_initial_default_apply(uuid,text,text,text,integer,jsonb,integer,uuid)','execute') can_execute", [role])).rows[0];
      expect(permissions).toEqual({ can_read: false, can_write: false, can_execute: false });
    }
    expect((await pool.query("select has_table_privilege('service_role','public.platform_ui_theme_defaults','select') can_read,has_table_privilege('service_role','public.platform_ui_theme_defaults','insert,update,delete') can_write, has_function_privilege('service_role','public.fn_ui_theme_seed_new_organization()','execute') seed_rpc")).rows[0])
      .toEqual({ can_read: true, can_write: false, seed_rpc: false });
    expect((await pool.query("select relrowsecurity from pg_class where oid='public.platform_ui_theme_defaults'::regclass")).rows[0].relrowsecurity).toBe(true);
  });
  it("schema/valores inválidos são barrados, sem gravação parcial", async () => {
    await expect(apply({ values: { "global.spacing": { hidden: true } } })).rejects.toMatchObject({ code: "22023" });
    await expect(apply({ theme: "<script>" })).rejects.toMatchObject({ code: "22023" });
    expect((await pool.query("select id from platform_ui_theme_defaults")).rows).toEqual([]);
  });
  it("criação revertida não deixa seleção ou auditoria solta", async () => {
    await apply();const id = randomUUID(),client = await pool.connect();
    try {await client.query("begin");await client.query("insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Teste','Teste')", [id]);await client.query("rollback");}
    finally {client.release();}
    expect((await pool.query("select organization_id from organization_ui_themes where organization_id=$1", [id])).rows).toEqual([]);
    expect((await pool.query("select action from api_audit_log where organization_id=$1 and action='ui_theme.updated'", [id])).rows).toEqual([]);
  });
  it("reaplicar o apêndice não troca padrão ou escolhas já gravados", async () => {
    await apply();const id = await org();
    const before = (await pool.query("select theme_id,revision,configurations from platform_ui_theme_defaults where id=1")).rows[0];
    const sql = readFileSync("supabase/migrations/20261021163316_0726_ui_theme_initial_default.sql", "utf8");
    await pool.query(sql);
    expect((await pool.query("select theme_id,revision,configurations from platform_ui_theme_defaults where id=1")).rows[0]).toEqual(before);
    expect((await pool.query("select theme_id,revision from organization_ui_themes where organization_id=$1", [id])).rows[0]).toEqual({ theme_id: "demo", revision: 1 });
  });
});
