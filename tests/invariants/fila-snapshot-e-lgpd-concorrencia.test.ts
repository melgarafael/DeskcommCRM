/**
 * Duas sessões mutantes reais: produtor interno × anonimização canônica.
 * O controle inseguro mostra por que ACL/EXISTS sozinhos não são barreira de concorrência.
 * O contrato seguro usa o mutex de atendimento EXISTENTE antes do lock do job.
 * Isto não prova a fiação do produtor no #3525, que ainda precisa adotá-lo.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 3,
});
const orgs: string[] = [];
async function fixture() {
  const org=randomUUID(), contact=randomUUID(), job=randomUUID(), user=randomUUID(); orgs.push(org);
  await pool.query("insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Concorrência sintética','Concorrência sintética')",[org]);
  await pool.query("insert into auth.users(id,email) values($1,$2)",[user,`${user}@invariant.test`]);
  await pool.query("insert into user_organizations(organization_id,user_id,role,accepted_at) values($1,$2,'manager',now())",[org,user]);
  await pool.query("insert into contacts(id,organization_id,name,display_name) values($1,$2,'Titular sintético','Titular sintético')",[contact,org]);
  const row=(await pool.query(`insert into job_queue(id,organization_id,contact_id,kind,status,locked_by,locked_at,payload)
    values($1,$2,$3,'inbound_turn','running','catalog-worker',clock_timestamp(),'{}') returning locked_at::text as acquired`,[job,org,contact])).rows[0];
  // Estado sintético coerente; este teste NÃO prova autorização do runtime.
  const product=randomUUID();
  const state={ schema_version:1, sends_already_counted:0, ordered_product_codes:["A"],
    plan:{items:[{product_id:product,product_code:"A",product_name:"Produto A",
      messages:[{kind:"text",purpose:"presentation",product_id:product,product_code:"A",text:"Texto sintético"}],
      physical_message_count:1}],physical_message_count:1},
    agent_operation:{organizationId:org,agentId:randomUUID(),versionId:randomUUID(),revision:"1"} };
  return {org,contact,job,user,acquired:row.acquired as string,state};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function begin(client: pg.PoolClient) {
  await client.query("begin; set local role service_role; set local statement_timeout='5s'");
  await client.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({role:"service_role"})]);
}
const update=`update public.job_queue j set catalog_presentation_snapshot=$5::jsonb
  where j.id=$1 and j.organization_id=$2 and j.kind='inbound_turn' and j.status='running'
    and j.locked_by=$3 and j.locked_at=$4::timestamptz and j.catalog_presentation_snapshot is null
    and exists(select 1 from public.contacts c where c.id=j.contact_id and c.organization_id=j.organization_id and not c.is_anonymized)
  returning j.id`;
const args=(f:Fixture)=>[f.job,f.org,"catalog-worker",f.acquired,JSON.stringify(f.state)];
async function freezeWithCurrentLease(client:pg.PoolClient,f:Fixture,commit=true) {
  await begin(client);
  // ORDEM canônica já existente: contato (advisory) antes do job (row lock).
  await client.query("select public.fn_service_lock($1,$2)",[f.org,f.contact]);
  await client.query(`select id from public.job_queue where id=$1 and organization_id=$2 and contact_id=$3
    and status='running' and locked_by='catalog-worker' and locked_at=$4::timestamptz for update`,[f.job,f.org,f.contact,f.acquired]);
  const written=await client.query(update,args(f));
  if(commit) await client.query("commit");
  return written.rowCount;
}
async function anonymize(client:pg.PoolClient,f:Fixture,commit=true) {
  await begin(client);
  await client.query("select public.fn_lgpd_cascade_redact_contact($1,$2,$3)",[f.org,f.contact,randomUUID()]);
  if(commit) await client.query("commit");
}
async function anonymizeDirect(client:pg.PoolClient,f:Fixture,commit=true) {
  await client.query("begin; set local role authenticated; set local statement_timeout='5s'");
  await client.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({role:"authenticated",sub:f.user,aal:"aal1"})]);
  const result=await client.query("update public.contacts set is_anonymized=true,anonymized_at=clock_timestamp() where id=$1 and organization_id=$2 returning id",[f.contact,f.org]);
  if(commit) await client.query("commit");
  return result.rowCount;
}
async function pid(client:pg.PoolClient) {return Number((await client.query("select pg_backend_pid() as pid")).rows[0].pid);}
async function blockedBy(waiter:number,holder:number) {
  await expect.poll(async()=>{
    const row=(await pool.query("select wait_event,pg_blocking_pids(pid) as blockers from pg_stat_activity where pid=$1",[waiter])).rows[0];
    return row?.wait_event==="advisory" && row.blockers.includes(holder);
  },{timeout:5000,interval:10}).toBe(true);
}
async function state(f:Fixture) {return (await pool.query("select catalog_presentation_snapshot from job_queue where id=$1",[f.job])).rows[0].catalog_presentation_snapshot;}
afterAll(async()=>{
  for(const org of orgs) await pool.query("delete from job_queue where organization_id=$1",[org]);
  await pool.end();
});

describe("congelamento de catálogo e anonimização em duas sessões",()=>{
  it("controle causal: UPDATE único com EXISTS pode repor coluna depois do trigger da RPC",async()=>{
    const f=await fixture(),redactor=await pool.connect(),writer=await pool.connect();
    try{
      await anonymize(redactor,f,false); // A coluna era NULL: cleanup pode não ter row lock no job.
      await begin(writer);
      const written=await writer.query(update,args(f));
      await writer.query("commit");
      await redactor.query("commit");
      expect(written.rowCount).toBe(1);
      expect(await state(f)).toEqual(f.state);
    }finally{
      await redactor.query("rollback");await writer.query("rollback");redactor.release();writer.release();
    }
  });
  it("anonimizar primeiro: produtor espera mutex e depois não grava",async()=>{
    const f=await fixture(),redactor=await pool.connect(),writer=await pool.connect();
    let pending:Promise<number|null>|undefined;
    try{
      const redactorPid=await pid(redactor),writerPid=await pid(writer);
      await anonymize(redactor,f,false);
      pending=freezeWithCurrentLease(writer,f); const observed=pending.catch(()=>null);
      await blockedBy(writerPid,redactorPid);
      await redactor.query("commit");
      expect(await pending).toBe(0);await observed;
      expect(await state(f)).toBeNull();
    }finally{
      await redactor.query("rollback");await pending?.catch(()=>{});await writer.query("rollback");redactor.release();writer.release();
    }
  });
  it("congelar primeiro: LGPD espera mutex e limpa a coluna depois do commit",async()=>{
    const f=await fixture(),redactor=await pool.connect(),writer=await pool.connect();
    let pending:Promise<void>|undefined;
    try{
      const redactorPid=await pid(redactor),writerPid=await pid(writer);
      expect(await freezeWithCurrentLease(writer,f,false)).toBe(1);
      pending=anonymize(redactor,f);const observed=pending.catch(()=>{});
      await blockedBy(redactorPid,writerPid);
      await writer.query("commit");
      await pending;await observed;
      expect(await state(f)).toBeNull();
    }finally{
      await writer.query("rollback");await pending?.catch(()=>{});await redactor.query("rollback");redactor.release();writer.release();
    }
  });
});


describe("UPDATE direto da sessão também obedece à barreira de anonimização",()=>{
  it("controle real: ACL/policy permitem a própria org e escondem a vizinha",async()=>{
    const f=await fixture(),other=await fixture(),session=await pool.connect();
    try{
      expect((await pool.query("select has_table_privilege('authenticated','public.contacts','UPDATE') as allowed")).rows[0].allowed).toBe(true);
      expect(await anonymizeDirect(session,f,false)).toBe(1);
      expect((await session.query("update contacts set is_anonymized=true,anonymized_at=clock_timestamp() where id=$1 returning id",[other.contact])).rowCount).toBe(0);
      await session.query("commit");
      expect((await pool.query("select is_anonymized from contacts where id=$1",[f.contact])).rows[0].is_anonymized).toBe(true);
      expect((await pool.query("select is_anonymized from contacts where id=$1",[other.contact])).rows[0].is_anonymized).toBe(false);
    }finally{await session.query("rollback");session.release();}
  });
  it("controle causal: EXISTS sozinho também perde contra UPDATE direto ainda não commitado",async()=>{
    const f=await fixture(),redactor=await pool.connect(),writer=await pool.connect();
    try{
      expect(await anonymizeDirect(redactor,f,false)).toBe(1);
      await begin(writer);
      expect((await writer.query(update,args(f))).rowCount).toBe(1);
      await writer.query("commit");await redactor.query("commit");
      expect(await state(f)).toEqual(f.state);
    }finally{await redactor.query("rollback");await writer.query("rollback");redactor.release();writer.release();}
  });
  it("UPDATE direto primeiro: trigger existente retém mutex e produtor espera, depois descarta",async()=>{
    const f=await fixture(),redactor=await pool.connect(),writer=await pool.connect();
    let pending:Promise<number|null>|undefined;
    try{
      const redactorPid=await pid(redactor),writerPid=await pid(writer);
      expect(await anonymizeDirect(redactor,f,false)).toBe(1);
      pending=freezeWithCurrentLease(writer,f);const observed=pending.catch(()=>null);
      await blockedBy(writerPid,redactorPid);
      await redactor.query("commit");
      expect(await pending).toBe(0);await observed;
      expect(await state(f)).toBeNull();
    }finally{await redactor.query("rollback");await pending?.catch(()=>{});await writer.query("rollback");redactor.release();writer.release();}
  });
  it("produtor primeiro: UPDATE direto recusa 40001 sem deadlock e retry integral limpa",async()=>{
    const f=await fixture(),redactor=await pool.connect(),writer=await pool.connect();
    try{
      expect(await freezeWithCurrentLease(writer,f,false)).toBe(1);
      // BEFORE ROW já possui a linha do contato; pg_try_advisory_xact_lock
      // evita esperar por quem tomou mutex antes do job. Não inverter locks.
      await expect(anonymizeDirect(redactor,f,false)).rejects.toMatchObject({code:"40001",message:"contact_redaction_busy"});
      await redactor.query("rollback");
      await writer.query("commit");
      expect(await anonymizeDirect(redactor,f)).toBe(1); // nova transação inteira
      expect(await state(f)).toBeNull();
    }finally{await writer.query("rollback");await redactor.query("rollback");redactor.release();writer.release();}
  });
});
