import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { seedGov, GOV_ORG as org, GOV_ADMIN as admin, GOV_MANAGER as manager } from "./gov-helpers";
const pool = new Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres` });
beforeAll(()=>seedGov()); afterAll(()=>pool.end());
async function toggle(user:string,target:string,enabled:boolean|null) {
  const c=await pool.connect();
  try { await c.query("begin");await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:user,aal:"aal1"})]);
    const result=await c.query("select fn_definir_modulo_academia($1,$2) enabled",[target,enabled]);
    await c.query("commit");return result.rows[0].enabled;
  } catch(e) {await c.query("rollback");throw e;} finally {c.release();}
}
describe("Academia instalada: isolamento, autorização e preservação",()=>{
  it("admin liga/desliga/religa sem apagar outras configurações nem dados",async()=>{
    await pool.query("update organizations set settings=settings || '{\"llm\":{\"provider\":\"openai\"},\"modules\":{\"outro\":true},\"academia\":{\"publicos\":[\"kids\"]}}' where id=$1",[org]);
    const before=(await pool.query("select settings from organizations where id=$1",[org])).rows[0].settings;
    expect(await toggle(admin,org,true)).toBe(true);
    expect(await toggle(admin,org,false)).toBe(false);
    expect(await toggle(admin,org,true)).toBe(true);
    const after=(await pool.query("select settings from organizations where id=$1",[org])).rows[0].settings;
    expect(after).toEqual({...before,modules:{...before.modules,academia:true}});
  });
  it("manager, usuário de outra empresa e anon não alteram a flag",async()=>{
    await expect(toggle(manager,org,false)).rejects.toMatchObject({code:"42501"});
    const other="a0000000-0000-4000-8000-000000000001", owner="a0000000-0000-4000-8000-000000000002";
    await pool.query("insert into organizations(id,slug,legal_name,display_name) values($1,'academia-other','Outra','Outra')",[other]);
    await pool.query("insert into auth.users(id,email) values($1,'academia-other@test.local')",[owner]);
    await pool.query("insert into user_organizations(organization_id,user_id,role,accepted_at) values($1,$2,'admin',now())",[other,owner]);
    await expect(toggle(owner,org,false)).rejects.toMatchObject({code:"42501"});
    expect(await toggle(owner,other,true)).toBe(true);
    expect(await toggle(owner,other,false)).toBe(false);
    expect((await pool.query("select settings->'modules'->'academia' enabled from organizations where id=$1",[org])).rows[0].enabled).toBe(true);
    expect((await pool.query("select has_function_privilege('anon','public.fn_definir_modulo_academia(uuid,boolean)','execute') allowed")).rows[0].allowed).toBe(false);
  });
  it("null não vira ativação implícita",async()=>{await expect(toggle(admin,org,null)).rejects.toMatchObject({code:"22023"});});
});
