import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { Pool } from "pg";
import { seedGov, GOV_ORG as org, GOV_ADMIN as admin, GOV_MANAGER as manager, GOV_VIEWER as viewer } from "./gov-helpers";
const pool = new Pool({connectionString:`postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`});
const other = randomUUID(), outsider = randomUUID();
async function as(user:string,query:string,args:unknown[]=[]) {
 const c=await pool.connect();
 try { await c.query("begin"); await c.query("set local role authenticated"); await c.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:user,aal:"aal1"})]); const result=await c.query(query,args);await c.query("commit");return result;
 } catch(e) {await c.query("rollback");throw e;} finally{c.release();}
}
beforeAll(async()=>{
 seedGov();
 await pool.query("update organizations set settings=jsonb_set(settings,'{modules}','{\"academia\":true}') where id=$1",[org]);
 await pool.query("insert into organizations(id,slug,legal_name,display_name,settings) values($1,'catalog-other','Outra','Outra','{\"modules\":{\"academia\":true}}')",[other]);
 await pool.query("insert into auth.users(id,email) values($1,'catalog-other@test.local')",[outsider]);
 await pool.query("insert into user_organizations(organization_id,user_id,role,accepted_at) values($1,$2,'admin',now())",[other,outsider]);
});
afterAll(()=>pool.end());
for(const kind of ["audiences","modalities","teachers","spaces"]) describe(`academia_${kind}`,()=>{
 const table=`academia_${kind}`;const id=randomUUID();
 it("gestor cria, leitor consulta e outra empresa não vê nem escreve",async()=>{
  expect((await as(manager,`insert into ${table}(id,organization_id,name) values($1,$2,'Teste') returning id`,[id,org])).rowCount).toBe(1);
  expect((await as(viewer,`select id from ${table} where id=$1`,[id])).rowCount).toBe(1);
  expect((await as(outsider,`select id from ${table} where id=$1`,[id])).rowCount).toBe(0);
  expect((await as(outsider,`update ${table} set name='Invadido' where id=$1 returning id`,[id])).rowCount).toBe(0);
  await expect(as(outsider,`insert into ${table}(organization_id,name) values($1,'Intruso')`,[org])).rejects.toMatchObject({code:"42501"});
  await expect(as(viewer,`insert into ${table}(organization_id,name) values($1,'Leitor')`,[org])).rejects.toMatchObject({code:"42501"});
 });
 it("CAS rejeita edição antiga e desativação preserva identidade",async()=>{
  const updated=await as(manager,`update ${table} set active=false where id=$1 and revision=1 returning revision,active`,[id]);
  expect(updated.rows[0]).toEqual({revision:2,active:false});
  expect((await as(manager,`update ${table} set name='Stale' where id=$1 and revision=1 returning id`,[id])).rowCount).toBe(0);
  expect((await as(admin,`update ${table} set active=true where id=$1 and revision=2 returning revision`,[id])).rows[0].revision).toBe(3);
  await expect(as(admin,`update ${table} set organization_id=$1 where id=$2`,[other,id])).rejects.toMatchObject({code:"42501"});
  await expect(as(admin,`update ${table} set revision=99 where id=$1`,[id])).rejects.toMatchObject({code:"42501"});
  await expect(as(admin,`delete from ${table} where id=$1`,[id])).rejects.toMatchObject({code:"42501"});
 });
 it("módulo desligado bloqueia até acesso direto ao banco e religar preserva",async()=>{
  await as(admin,"select fn_definir_modulo_academia($1,false)",[org]);
  try{
   expect((await as(admin,`select id from ${table} where id=$1`,[id])).rowCount).toBe(0);
   await expect(as(admin,`insert into ${table}(organization_id,name) values($1,'Desligado')`,[org])).rejects.toMatchObject({code:"42501"});
  } finally { await as(admin,"select fn_definir_modulo_academia($1,true)",[org]); }
  expect((await as(admin,`select name from ${table} where id=$1`,[id])).rows[0].name).toBe("Teste");
  expect((await pool.query("select has_table_privilege('anon',$1,'select') allowed",[table])).rows[0].allowed).toBe(false);
 });
 it("nome repetido por empresa é recusado; outra empresa usa o mesmo nome",async()=>{
  await expect(as(manager,`insert into ${table}(organization_id,name) values($1,' teste ')`,[org])).rejects.toMatchObject({code:"23505"});
  expect((await as(outsider,`insert into ${table}(organization_id,name) values($1,'Teste') returning id`,[other])).rowCount).toBe(1);
 });
});
it("banco rejeita faixa invertida independentemente da interface",async()=>{
 await expect(as(manager,"insert into academia_audiences(organization_id,name,min_age,max_age) values($1,'Invertido',15,11)",[org])).rejects.toMatchObject({code:"23514"});
});
