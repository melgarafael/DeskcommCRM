import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, it, expect } from "vitest";
import { Pool } from "pg";
import { seedGov, GOV_ORG as org, GOV_ADMIN as admin, GOV_MANAGER as manager, GOV_VIEWER as viewer } from "./gov-helpers";
const pool = new Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres` });
const other = randomUUID(), outsider = randomUUID();
const kinds = ["modalities", "audiences", "teachers", "spaces"];
const ids = kinds.map(() => randomUUID());
const foreignIds = kinds.map(() => randomUUID());
const fields = ["modality_id", "audience_id", "teacher_id", "space_id"];
async function as(user: string, query: string, args: unknown[] = []) {
  const c = await pool.connect();
  try {
    await c.query("begin"); await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, aal: "aal1" })]);
    const result = await c.query(query, args); await c.query("commit"); return result;
  } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
}
function insert(user = manager, refs = ids, tenant = org) {
  return as(user, "insert into academia_weekly_classes(organization_id,modality_id,audience_id,teacher_id,space_id,weekday,start_time,duration_minutes) values($1,$2,$3,$4,$5,1,'08:30',45) returning *", [tenant, ...refs]);
}
beforeAll(async () => {
  seedGov();
  await pool.query("update organizations set settings=jsonb_set(settings,'{modules}','{\"academia\":true}') where id=$1", [org]);
  await pool.query("insert into organizations(id,slug,legal_name,display_name,settings) values($1,'schedule-other','Outra','Outra','{\"modules\":{\"academia\":true}}')", [other]);
  await pool.query("insert into auth.users(id,email) values($1,'schedule-other@test.local')", [outsider]);
  await pool.query("insert into user_organizations(organization_id,user_id,role,accepted_at) values($1,$2,'admin',now())", [other, outsider]);
  for (const [i, kind] of kinds.entries()) {
    await as(manager, `insert into academia_${kind}(id,organization_id,name) values($1,$2,'Grade de teste')`, [ids[i], org]);
    await as(outsider, `insert into academia_${kind}(id,organization_id,name) values($1,$2,'Grade de teste')`, [foreignIds[i], other]);
  }
});
afterAll(() => pool.end());
it("gestor cria aulas simultâneas e leitor consulta; outra empresa não lê nem edita", async () => {
  const first = (await insert()).rows[0];
  const second = (await insert()).rows[0];
  expect(first.id).not.toBe(second.id);
  expect((await as(viewer, "select id from academia_weekly_classes where id=$1", [first.id])).rowCount).toBe(1);
  expect((await as(outsider, "select id from academia_weekly_classes where id=$1", [first.id])).rowCount).toBe(0);
  expect((await as(outsider, "update academia_weekly_classes set active=false where id=$1 returning id", [first.id])).rowCount).toBe(0);
  await expect(insert(viewer)).rejects.toMatchObject({ code: "42501" });
  await expect(insert(outsider)).rejects.toBeDefined();
});
it.each(kinds)("recusa vínculo cross-tenant em %s, inclusive sem RLS", async kind => {
  const refs = [...ids]; const i = kinds.indexOf(kind); refs[i] = foreignIds[i]!;
  await expect(insert(manager, refs)).rejects.toMatchObject({ code: "23514" });
  // Sem a filtragem RLS, o trigger também recusa vínculos de outra empresa.
  const row = (await insert()).rows[0];
  const c = await pool.connect();
  try {
    await expect(c.query(`update academia_weekly_classes set ${fields[i]}=$1 where id=$2`, [foreignIds[i], row.id])).rejects.toMatchObject({ code: "23514" });
  } finally { c.release(); }
  const fk = await pool.query("select pg_get_constraintdef(oid) definition from pg_constraint where conrelid='academia_weekly_classes'::regclass and contype='f'");
  expect(fk.rows.some(r => r.definition.includes(`FOREIGN KEY (organization_id, ${fields[i]})`))).toBe(true);
});
it("revisão antiga não sobrescreve; não há DELETE ou alteração de tenant", async () => {
  const row = (await insert()).rows[0];
  expect((await as(manager, "update academia_weekly_classes set active=false where id=$1 and revision=1 returning revision", [row.id])).rows[0].revision).toBe(2);
  expect((await as(manager, "update academia_weekly_classes set active=true where id=$1 and revision=1 returning id", [row.id])).rowCount).toBe(0);
  await expect(as(admin, "delete from academia_weekly_classes where id=$1", [row.id])).rejects.toMatchObject({ code: "42501" });
  for (const field of ["organization_id", "id", "revision", "created_at"]) {
    await expect(as(admin, `update academia_weekly_classes set ${field}=${field} where id=$1`, [row.id])).rejects.toMatchObject({ code: "42501" });
  }
});
it("cadastro inativo preserva a aula antiga, mas impede vínculo novo e reativação", async () => {
  const row = (await insert()).rows[0];
  await as(manager, "update academia_teachers set active=false where id=$1", [ids[2]]);
  try {
    await expect(insert()).rejects.toMatchObject({ code: "23514" });
    expect((await as(manager, "update academia_weekly_classes set notes='Revisar professor',active=false where id=$1 returning id", [row.id])).rowCount).toBe(1);
    await expect(as(manager, "update academia_weekly_classes set active=true where id=$1", [row.id])).rejects.toMatchObject({ code: "23514" });
  } finally { await as(manager, "update academia_teachers set active=true where id=$1", [ids[2]]); }
  expect((await as(manager, "update academia_weekly_classes set active=true where id=$1 returning id", [row.id])).rowCount).toBe(1);
});
it("módulo desligado bloqueia acesso e preserva dados ao religar", async () => {
  const row = (await insert()).rows[0];
  await as(admin, "select fn_definir_modulo_academia($1,false)", [org]);
  try {
    expect((await as(admin, "select id from academia_weekly_classes")).rowCount).toBe(0);
    await expect(insert()).rejects.toBeDefined();
  } finally { await as(admin, "select fn_definir_modulo_academia($1,true)", [org]); }
  expect((await as(admin, "select id from academia_weekly_classes where id=$1", [row.id])).rowCount).toBe(1);
  expect((await pool.query("select has_table_privilege('anon','academia_weekly_classes','select') allowed")).rows[0].allowed).toBe(false);
});
it.each(["weekday=0", "weekday=8", "duration_minutes=0", "duration_minutes=1441", "start_time='24:00'", "start_time='08:30:01'"])("banco rejeita %s", async change => {
  const row = (await insert()).rows[0];
  await expect(as(manager, `update academia_weekly_classes set ${change} where id=$1`, [row.id])).rejects.toMatchObject({ code: "23514" });
});
