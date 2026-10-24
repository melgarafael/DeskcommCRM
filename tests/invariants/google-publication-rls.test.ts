import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const pool = new pg.Pool({connectionString:`postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,max:3});
const tenants=[randomUUID(),randomUUID()] as const;
const users=[randomUUID(),randomUUID()] as const;
const rows=[randomUUID(),randomUUID()] as const;
const contacts=[randomUUID(),randomUUID()] as const,conversations=[randomUUID(),randomUUID()] as const,callbacks=[randomUUID(),randomUUID()] as const,requests=[randomUUID(),randomUUID()] as const;
beforeAll(async()=>{
 for(const i of [0,1] as const){
  const org=tenants[i],user=users[i],contact=contacts[i],conversation=conversations[i],channel=randomUUID(),job=randomUUID();
  await pool.query("insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Fictitious','Fictitious')",[org]);
  await pool.query('insert into auth.users(id,email) values($1,$2)',[user,`${user}@example.test`]);
  await pool.query("insert into user_organizations(organization_id,user_id,role,accepted_at) values($1,$2,'admin',now())",[org,user]);
  await pool.query("insert into contacts(id,organization_id,display_name) values($1,$2,'Fictitious')",[contact,org]);
  await pool.query("insert into channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted) values($1::uuid,$2,$1::text,$3)",[channel,org,Buffer.from([0])]);
  await pool.query("insert into conversations(id,organization_id,contact_id,channel_session_id) values($1,$2,$3,$4)",[conversation,org,contact,channel]);
  await pool.query("insert into job_queue(id,organization_id,contact_id,kind,payload) values($1,$2,$3,'inbound_turn',$4)",[job,org,contact,{conversation_id:conversation}]);
  await pool.query("insert into messages(id,organization_id,contact_id,conversation_id,channel_session_id,type,direction,status,body) values($1,$2,$3,$4,$5,'text','inbound','received','Fictitious request')",[requests[i],org,contact,conversation,channel]);
  await pool.query("insert into job_queue(id,organization_id,contact_id,kind,payload) values($1,$2,$3,'google_publication_turn',$4)",[callbacks[i],org,contact,{conversation_id:conversation}]);
  await pool.query("insert into google_publication_continuations(id,organization_id,contact_id,conversation_id,source_job_id,operation_key,appointment_ids,revisions,service_boundary) values($1,$2,$3,$4,$5,'rls-fixture','{}','{}','{}')",[rows[i],org,contact,conversation,job]);
  await pool.query("update google_publication_continuations set job_id=$2,request_message_id=$3 where id=$1",[rows[i],callbacks[i],requests[i]]);
 }
});
afterAll(async()=>{
 await pool.query('delete from organizations where id=any($1::uuid[])',[tenants]);
 await pool.query('delete from auth.users where id=any($1::uuid[])',[users]);
 await pool.end();
});
describe('internal continuation table preserves grants and tenant RLS',()=>{
 it('seeds positive rows in both tenants and keeps RLS enabled',async()=>{
  expect((await pool.query('select organization_id from google_publication_continuations where id=any($1::uuid[]) order by organization_id',[rows])).rows).toHaveLength(2);
  expect((await pool.query("select relrowsecurity from pg_class where oid='public.google_publication_continuations'::regclass")).rows[0].relrowsecurity).toBe(true);
 });
 it.each(['anon','authenticated'])('direct read/write is denied to %s, including own-tenant admin',async(role)=>{
  const c=await pool.connect();
  try{
   for(const operation of ['select * from google_publication_continuations',"update google_publication_continuations set state='stale'",'delete from google_publication_continuations']){
    await c.query('begin');await c.query(`set local role ${role}`);
    await c.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:users[0],role})]);
    await expect(c.query(operation)).rejects.toMatchObject({code:'42501'});await c.query('rollback');
   }
  }finally{await c.query('rollback');c.release();}
 });
 it('JWT sees only its own real row even if read privilege is accidentally widened; grants are rolled back',async()=>{
  for(const i of [0,1] as const){
   const c=await pool.connect();
   try{
    await c.query('begin');
    // Transaction-local privilege change to exercise the policy independently.
    // Rollback restores the actual deny-all public table privilege.
    await c.query('grant select on google_publication_continuations to authenticated');
    await c.query('set local role authenticated');
    await c.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:users[i],role:'authenticated'})]);
    expect((await c.query('select id from google_publication_continuations where organization_id=$1',[tenants[i]])).rows).toEqual([{id:rows[i]}]);
    expect((await c.query('select id from google_publication_continuations where organization_id=$1',[tenants[i === 0 ? 1 : 0]])).rows).toEqual([]);
    expect((await c.query('select id from google_publication_continuations')).rows).toEqual([{id:rows[i]}]);
    await c.query('rollback');
   }finally{await c.query('rollback');c.release();}
  }
  expect((await pool.query("select has_table_privilege('authenticated','google_publication_continuations','SELECT') allowed")).rows[0].allowed).toBe(false);
 });
 it('readonly request projection is scoped by JWT, tenant, contact, conversation and native job',async()=>{
  for(const i of [0,1] as const){
   const c=await pool.connect();
   try{
    await c.query('begin');await c.query('set local role authenticated');
    await c.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:users[i],role:'authenticated'})]);
    const request=async(org:string,contact:string,conversation:string,job:string)=>(await c.query('select fn_google_continuation_request_message($1,$2,$3,$4) id',[org,contact,conversation,job])).rows[0].id;
    expect(await request(tenants[i],contacts[i],conversations[i],callbacks[i])).toBe(requests[i]);
    expect(await request(tenants[i === 0 ? 1 : 0],contacts[i === 0 ? 1 : 0],conversations[i === 0 ? 1 : 0],callbacks[i === 0 ? 1 : 0])).toBeNull();
    expect(await request(tenants[i],contacts[i === 0 ? 1 : 0],conversations[i],callbacks[i])).toBeNull();
    expect(await request(tenants[i],contacts[i],conversations[i === 0 ? 1 : 0],callbacks[i])).toBeNull();
    expect(await request(tenants[i],contacts[i],conversations[i],callbacks[i === 0 ? 1 : 0])).toBeNull();
    await c.query("select set_config('request.jwt.claims','{}',true)");
    expect(await request(tenants[i],contacts[i],conversations[i],callbacks[i])).toBeNull();
    await c.query('rollback');
   }finally{await c.query('rollback');c.release();}
  }
  expect((await pool.query("select has_function_privilege('anon','fn_google_continuation_request_message(uuid,uuid,uuid,uuid)','EXECUTE') allowed")).rows[0].allowed).toBe(false);
 });
 it('public roles cannot claim or forge continuation receipts; service keeps native RPC access',async()=>{
  for(const role of ['anon','authenticated']){
   expect((await pool.query("select has_function_privilege($1,'fn_google_continuation_current(uuid,uuid,text,timestamptz)','EXECUTE') allowed",[role])).rows[0].allowed).toBe(false);
   expect((await pool.query("select has_function_privilege($1,'fn_google_continuation_register(uuid,uuid[],text,jsonb)','EXECUTE') allowed",[role])).rows[0].allowed).toBe(false);
  }
  expect((await pool.query("select has_function_privilege('service_role','fn_google_continuation_current(uuid,uuid,text,timestamptz)','EXECUTE') allowed")).rows[0].allowed).toBe(true);
 });
});
