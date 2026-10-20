import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { carregarContextoDoAtendimento, projetarContextoDoAtendimento } from "@/lib/agent-engine/agent/contexto-do-atendimento";
import { pacoteFactualDaRevisao } from "@/lib/agent-engine/guardrails/promise/contrato-contexto";

const pool = new pg.Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`, max: 5 });
const org = randomUUID(), other = randomUUID(), owner = randomUUID(), channel = randomUUID(), connection = randomUUID();
beforeAll(async () => {
  for (const id of [org, other]) await pool.query("insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Fictitious bookings','Fictitious bookings')", [id]);
  await pool.query("insert into auth.users(id,email) values($1,$2)", [owner, `${owner}@example.test`]);
  await pool.query("insert into user_organizations(organization_id,user_id,role,accepted_at) values($1,$2,'admin',now())", [org, owner]);
  await pool.query("insert into calendar_connections(id,organization_id,user_id,account_email,status) values($1,$2,$3,$4,'healthy')",[connection,org,owner,`${owner}@example.test`]);
  await pool.query("insert into channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted,status) values($1::uuid,$2,$1::text,'\\x00','WORKING')", [channel,org]);
});
afterAll(async () => {
  await pool.query("delete from organizations where id=any($1::uuid[])", [[org,other]]);
  await pool.query("delete from auth.users where id=$1",[owner]);
  await pool.end();
});

let fixtureSequence = 0;
async function fixture() {
  const start = new Date(Date.UTC(2027, 0, 10, 15) + fixtureSequence++ * 86400000);
  const end = new Date(start.getTime() + 40 * 60000);
  const contact=randomUUID(), conv=randomUUID(), message=randomUUID(), appointment=randomUUID();
  await pool.query("insert into contacts(id,organization_id,display_name) values($1,$2,'Fictitious contact')",[contact,org]);
  await pool.query("insert into conversations(id,organization_id,contact_id,channel_session_id,status) values($1,$2,$3,$4,'open')",[conv,org,contact,channel]);
  await pool.query("insert into messages(id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,sent_via,body,sent_at) values($1,$2,$3,$4,$5,'text','inbound','received','ai','Please book my chosen time',now())",[message,org,conv,channel,contact]);
  const {rows:[job]}=await pool.query("insert into job_queue(organization_id,contact_id,kind,payload,status,locked_by,locked_at) values($1,$2,'inbound_turn',$3,'running','publication-test',clock_timestamp()) returning *,locked_at::text acquired",[org,contact,{conversation_id:conv,inbound_message_id:message}]);
  await pool.query("insert into calendar_appointments(id,organization_id,contact_id,conversation_id,owner_user_id,title,starts_at,ends_at,status) values($1,$2,$3,$4,$5,'Fictitious appointment',$6,$7,'confirmed')",[appointment,org,contact,conv,owner,start.toISOString(),end.toISOString()]);
  const {rows:[boundary]}=await pool.query("select fn_service_boundary($1,$2) b",[org,conv]);
  const execution={boundary:boundary.b,job:{id:job.id,worker_id:"publication-test",acquired_at:job.acquired}};
  const {rows:[r]}=await pool.query("select fn_google_continuation_register($1,$2,$3,$4) r",[org,[appointment],`booking:${appointment}`,execution]);
  return {contact,conv,message,appointment,job,execution,id:r.r.id};
}
async function acknowledge(f: Awaited<ReturnType<typeof fixture>>) {
  await pool.query("update calendar_appointments set google_event_id='event-'||id::text,google_synced_local_revision=google_local_revision,google_sync_error=null,google_sync_failure_kind=null where organization_id=$1 and id=$2",[org,f.appointment]);
}
async function finish(f: Awaited<ReturnType<typeof fixture>>) {
  return (await pool.query("select fn_google_continuation_finish($1,$2,$3) r",[org,f.id,f.job.id])).rows[0].r;
}
async function queued(f: Awaited<ReturnType<typeof fixture>>) {
  return (await pool.query("select j.* from job_queue j join google_publication_continuations c on c.organization_id=j.organization_id and c.job_id=j.id where c.organization_id=$1 and c.id=$2",[org,f.id])).rows;
}
async function claim(f: Awaited<ReturnType<typeof fixture>>) {
  await pool.query("update job_queue set status='done',locked_by=null,locked_at=null where organization_id=$1 and id=$2",[org,f.job.id]);
  const {rows:[j]}=await pool.query("update job_queue set status='running',locked_by='continuation-test',locked_at=clock_timestamp() where organization_id=$1 and id=(select job_id from google_publication_continuations where organization_id=$1 and id=$2) returning *,locked_at::text acquired",[org,f.id]);
  return j;
}
async function current(j: {id:string;acquired:string}) {
  return (await pool.query("select fn_google_continuation_current($1,$2,'continuation-test',$3) r",[org,j.id,j.acquired])).rows[0].r;
}

describe("native Google continuation owns one current response", () => {
  it("immediate publication leaves the original turn as the exclusive owner", async () => {
    const f=await fixture();await acknowledge(f);
    expect(await finish(f)).toMatchObject({deferred:false});
    await acknowledge(f);expect(await queued(f)).toHaveLength(0);
    expect(await finish(f)).toMatchObject({deferred:false});
  });
  it("waiting does not create a Case/job; acknowledgement and re-delivery enqueue exactly once", async () => {
    const f=await fixture();expect(await finish(f)).toMatchObject({deferred:true});
    expect(await queued(f)).toHaveLength(0);
    expect((await pool.query("select count(*)::int n from agent_cases where organization_id=$1 and conversation_id=$2",[org,f.conv])).rows[0].n).toBe(0);
    await acknowledge(f);await acknowledge(f);await pool.query("select fn_google_continuation_recover()");
    const q=await queued(f);expect(q).toHaveLength(1);expect(q[0].kind).toBe("google_publication_turn");
    expect(await finish(f)).toMatchObject({deferred:true});
    const j=await claim(f);expect(await current(j)).toMatchObject({conversation_id:f.conv,outcome:"synced"});
    const context=await carregarContextoDoAtendimento(pool,{tenantId:org,leadId:f.contact,conversationId:f.conv,jobId:j.id});
    const projected=JSON.stringify(projetarContextoDoAtendimento(context));
    expect(projected).toContain("synced");expect(projected).toContain("Please book my chosen time");
    expect(JSON.stringify(pacoteFactualDaRevisao({candidate:"The reservation is published.",serviceContext:context}))).toContain("synced");
  });
  it("a publication racing with handoff gives ownership to exactly one path", async () => {
    const f=await fixture();
    const [result]=await Promise.all([finish(f),acknowledge(f)]);
    const jobs=await queued(f);
    expect(result.deferred ? jobs.length : jobs.length===0).toBe(result.deferred ? 1 : true);
  });
  it("transient errors keep recovery; real failures wake the same native guarded turn", async () => {
    const f=await fixture();await finish(f);
    await pool.query("update calendar_appointments set google_sync_error='Temporary outage',google_sync_failure_kind='transient' where organization_id=$1 and id=$2",[org,f.appointment]);
    expect(await queued(f)).toHaveLength(0);
    await pool.query("update calendar_appointments set google_sync_error='Reconnect account',google_sync_failure_kind='human_required' where organization_id=$1 and id=$2",[org,f.appointment]);
    const j=await claim(f);expect(await current(j)).toMatchObject({outcome:"human_required"});
  });
  it.each(["cancelled","rescheduled","demand","blocked","human"])("rejects a %s change before the continuation acts",async (change) => {
    const f=await fixture();await finish(f);await acknowledge(f);const j=await claim(f);
    if(change==="cancelled") await pool.query("update calendar_appointments set status='cancelled',cancelled_at=now(),cancellation_reason='Synthetic cancellation' where organization_id=$1 and id=$2",[org,f.appointment]);
    if(change==="rescheduled") await pool.query("update calendar_appointments set starts_at=starts_at+interval '1 hour',ends_at=ends_at+interval '1 hour' where organization_id=$1 and id=$2",[org,f.appointment]);
    if(change==="demand") await pool.query("update conversations set service_revision=service_revision+1 where organization_id=$1 and id=$2",[org,f.conv]);
    if(change==="blocked") await pool.query("update contacts set is_blocked=true where organization_id=$1 and id=$2",[org,f.contact]);
    if(change==="human") {
      await pool.query("update conversations set assigned_to_user_id=$3 where organization_id=$1 and id=$2",[org,f.conv,owner]);
      await pool.query("insert into conversation_assignment_events(organization_id,conversation_id,to_user_id,reason) values($1,$2,$3,'claim')",[org,f.conv,owner]);
    }
    expect(await current(j)).toBeNull();
  });
  it("anonymization revokes a previously ready continuation and preserves only technical audit metadata",async()=>{
    const f=await fixture();await finish(f);await acknowledge(f);const j=await claim(f);
    expect(await current(j)).toMatchObject({outcome:"synced"});
    await pool.query("update contacts set is_anonymized=true,anonymized_at=now() where organization_id=$1 and id=$2",[org,f.contact]);
    expect(await current(j)).toBeNull();
    expect((await pool.query("select state,request_message_id from google_publication_continuations where organization_id=$1 and id=$2",[org,f.id])).rows).toHaveLength(1);
    expect((await pool.query("select body from messages where organization_id=$1 and id=$2",[org,f.message])).rows[0].body).not.toBe("Please book my chosen time");
    expect((await pool.query("select status from job_queue where organization_id=$1 and id=$2",[org,j.id])).rows[0].status).toBe("failed");
  });
  it("cannot enroll, settle or read a foreign organization's appointment/job",async () => {
    const f=await fixture();
    await expect(pool.query("select fn_google_continuation_register($1,$2,$3,$4)",[other,[f.appointment],"foreign",f.execution])).rejects.toMatchObject({code:"42501"});
    await expect(pool.query("select fn_google_continuation_finish($1,$2,$3)",[other,f.id,f.job.id])).rejects.toMatchObject({code:"42501"});
    expect((await pool.query("select fn_google_continuation_outcome($1,$2) r",[other,f.id])).rows[0].r).toBe("stale");
  });
  it("a newer inbound owns the request; the old callback cannot confirm it",async () => {
    const f=await fixture();await finish(f);await acknowledge(f);const j=await claim(f);
    await pool.query("insert into messages(organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,sent_via,body,sent_at) values($1,$2,$3,$4,'text','inbound','received','ai','I need a different date',now())",[org,f.conv,channel,f.contact]);
    expect(await current(j)).toBeNull();
    expect(await finish(f)).toMatchObject({deferred:true,state:"stale"});
  });
  it("claim and release cannot revive a revoked confirmation, even with an earlier transaction timestamp",async () => {
    const f=await fixture();await finish(f);await acknowledge(f);const j=await claim(f);
    await pool.query("update conversations set assigned_to_user_id=$3 where organization_id=$1 and id=$2",[org,f.conv,owner]);
    await pool.query("insert into conversation_assignment_events(organization_id,conversation_id,to_user_id,reason,created_at) values($1,$2,$3,'claim',now()-interval '1 day')",[org,f.conv,owner]);
    await pool.query("update conversations set assigned_to_user_id=null where organization_id=$1 and id=$2",[org,f.conv]);
    await pool.query("insert into conversation_assignment_events(organization_id,conversation_id,reason) values($1,$2,'release')",[org,f.conv]);
    expect(await current(j)).toBeNull();
  });
});


async function linkSyntheticLead(f: Awaited<ReturnType<typeof fixture>>) {
  const pipeline = randomUUID(), stage = randomUUID(), lead = randomUUID();
  await pool.query("insert into crm_pipelines(id,organization_id,name,slug) values($1::uuid,$2,'Fictitious recovery',$1::text)", [pipeline, org]);
  await pool.query("insert into crm_stages(id,organization_id,pipeline_id,name,slug,position) values($1::uuid,$2,$3,'Fictitious stage',$1::text,1000)", [stage, org, pipeline]);
  await pool.query("insert into crm_leads(id,organization_id,pipeline_id,stage_id,contact_id,title) values($1,$2,$3,$4,$5,'Fictitious reservation')", [lead, org, pipeline, stage, f.contact]);
  await pool.query("insert into crm_lead_links(organization_id,lead_id,target_kind,target_id,link_kind) values($1,$2,'appointment',$3,'booking')", [org, lead, f.appointment]);
  return lead;
}
async function newerRequest(f: Awaited<ReturnType<typeof fixture>>) {
  await pool.query("update job_queue set status='done',locked_by=null,locked_at=null where organization_id=$1 and id=$2", [org, f.job.id]);
  const message=randomUUID();
  await pool.query("insert into messages(id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,sent_via,body,sent_at) values($1,$2,$3,$4,$5,'text','inbound','received','ai','Is the same reservation ready?',now())",[message,org,f.conv,channel,f.contact]);
  const {rows:[j]}=await pool.query("insert into job_queue(organization_id,contact_id,kind,payload,status,locked_by,locked_at) values($1,$2,'inbound_turn',$3,'running','current-request',clock_timestamp()) returning *,locked_at::text acquired",[org,f.contact,{conversation_id:f.conv,inbound_message_id:message}]);
  const {rows:[boundary]}=await pool.query("select fn_service_boundary($1,$2) b",[org,f.conv]);
  return {message,job:j,execution:{boundary:boundary.b,job:{id:j.id,worker_id:'current-request',acquired_at:j.acquired}}};
}
describe("publication recognition survives auxiliary contention and a newer request",()=>{
  it("acknowledgement is not rolled back by a linked contact row lock",async()=>{
    const f=await fixture();const lead=await linkSyntheticLead(f);await finish(f);
    const calendar=randomUUID();
    await pool.query("insert into calendar_connection_calendars(id,organization_id,connection_id,external_calendar_id,name,available,access_role) values($1::uuid,$2,$3,$1::text,'Fictitious destination',true,'owner')",[calendar,org,connection]);
    await pool.query("update calendar_appointments set google_connection_id=$3,google_calendar_id=$4,google_event_id='event-'||id::text where organization_id=$1 and id=$2",[org,f.appointment,connection,calendar]);
    const holder=await pool.connect(),executor=await pool.connect();
    try {
      await holder.query('begin');
      await holder.query("select id from contacts where organization_id=$1 and id=$2 for update",[org,f.contact]);
      await executor.query("set statement_timeout='500ms'");
      const {rows:[snapshotRow]}=await executor.query("select fn_google_appointment($1,$2,'claim') snapshot",[org,f.appointment]);
      const s=snapshotRow.snapshot;
      const args={claim:s.claim,revision:s.revision,local_revision:s.google_local_revision,connection_id:s.google_connection_id,calendar_id:s.google_calendar_id,event_id:s.google_event_id,result:{ack:true,clear_pending:true,etag:'fictitious-etag'}};
      // Before the forward fix this is SQLSTATE57014 at the activity/contact FK.
      await expect(executor.query("select fn_google_appointment($1,$2,'commit',$3) snapshot",[org,f.appointment,args])).resolves.toMatchObject({rows:[{snapshot:{google_synced_local_revision:s.google_local_revision}}]});
      expect((await queued(f))).toHaveLength(0);
      expect((await pool.query("select state from google_publication_continuations where organization_id=$1 and id=$2",[org,f.id])).rows[0].state).toBe('waiting');
      const {rows:[lock]}=await executor.query("select pg_try_advisory_xact_lock(hashtextextended($1||':calendar_inventory',0)) free",[org]);
      expect(lock.free).toBe(true);
    } finally {
      await holder.query('rollback');holder.release();
      await executor.query('set statement_timeout=0');executor.release();
    }
    for(let i=0;i<2;i++)await pool.query("select fn_google_continuation_enqueue($1,$2)",[org,f.id]);
    expect((await queued(f))).toHaveLength(1);
    const j=await claim(f);
    const claimed={acquired:j.acquired};
    const auditHolder=await pool.connect();
    try {
      await auditHolder.query('begin');
      await auditHolder.query("select id from contacts where organization_id=$1 and id=$2 for update",[org,f.contact]);
      await expect(pool.query("select fn_google_continuation_activity($1,$2,'continuation-test',$3)",[org,j.id,j.acquired])).rejects.toMatchObject({code:'55P03'});
    } finally {await auditHolder.query('rollback');auditHolder.release();}
    for(let i=0;i<2;i++)expect((await pool.query("select fn_google_continuation_activity($1,$2,'continuation-test',$3) recorded",[org,j.id,claimed.acquired])).rows[0].recorded).toBe(true);
    expect((await pool.query("select count(*)::int n from crm_lead_activities where organization_id=$1 and lead_id=$2 and payload->>'continuation_id'=$3",[org,lead,f.id])).rows[0].n).toBe(1);
  });
  it("newer inbound adopts the same recovery with its own current authority",async()=>{
    const f=await fixture();await finish(f);const latest=await newerRequest(f);
    expect(await finish(f)).toMatchObject({state:'stale'});
    const args=[org,[f.appointment],latest.execution];
    for(let i=0;i<2;i++){
      const resumed=(await pool.query("select fn_google_continuation_resume($1,$2,$3) r",args)).rows[0].r;
      expect(resumed,JSON.stringify(resumed)).toMatchObject({resumed:true,deferred:true,state:'waiting'});
    }
    expect((await pool.query("select count(*)::int n from calendar_appointments where organization_id=$1 and contact_id=$2",[org,f.contact])).rows[0].n).toBe(1);
    await acknowledge(f);await acknowledge(f);
    const {rows}=await pool.query("select * from google_publication_continuations where organization_id=$1 and source_job_id=$2",[org,latest.job.id]);
    expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({state:'queued',request_message_id:latest.message});
    expect((await queued(f))).toHaveLength(0);
    const fresh={...f,id:rows[0].id,job:latest.job};const j=await claim(fresh);expect(await current(j)).toMatchObject({outcome:'synced'});
    const context=await carregarContextoDoAtendimento(pool,{tenantId:org,leadId:f.contact,conversationId:f.conv,jobId:j.id});
    const facts=JSON.stringify(pacoteFactualDaRevisao({candidate:'The reservation is published.',serviceContext:context}));
    expect(facts).toContain('synced');expect(facts).toContain('Is the same reservation ready?');
  });
  it.each(['cancelled','rescheduled','demand','human','foreign'])("new request cannot revive %s authority",async(change)=>{
    const f=await fixture();await finish(f);const latest=await newerRequest(f);
    if(change==='cancelled')await pool.query("update calendar_appointments set status='cancelled',cancelled_at=now(),cancellation_reason='Fictitious cancellation' where organization_id=$1 and id=$2",[org,f.appointment]);
    if(change==='rescheduled')await pool.query("update calendar_appointments set starts_at=starts_at+interval '1 hour',ends_at=ends_at+interval '1 hour' where organization_id=$1 and id=$2",[org,f.appointment]);
    if(change==='demand')await pool.query("update conversations set service_revision=service_revision+1 where organization_id=$1 and id=$2",[org,f.conv]);
    if(change==='human'){
      await pool.query("update conversations set assigned_to_user_id=$3 where organization_id=$1 and id=$2",[org,f.conv,owner]);
      await pool.query("insert into conversation_assignment_events(organization_id,conversation_id,to_user_id,reason) values($1,$2,$3,'claim')",[org,f.conv,owner]);
    }
    let result;
    try{result=(await pool.query("select fn_google_continuation_resume($1,$2,$3) r",[change==='foreign'?other:org,[f.appointment],latest.execution])).rows[0].r;}
    catch(e){expect((e as {code:string}).code).toBe('42501');return;}
    expect(result).toMatchObject({resumed:false});
  });
});


async function sentimentContext(f: Awaited<ReturnType<typeof fixture>>, message: string, tenant=org) {
  return (await pool.query("select fn_google_publication_sentiment_context($1,$2,$3) r",[tenant,f.conv,message])).rows[0].r;
}
describe("sentiment alert respects the native current publication request",()=>{
  it("defers briefly, then recognizes only the current native adoption, never an older message",async()=>{
    const f=await fixture();await finish(f);const latest=await newerRequest(f);
    const context=await sentimentContext(f,latest.message);
    expect(context).toMatchObject({owned:false});
    const remaining=Date.parse(context.wait_until)-Date.now();expect(remaining).toBeGreaterThan(0);expect(remaining).toBeLessThanOrEqual(120000);
    expect((await pool.query("select fn_google_continuation_resume($1,$2,$3) r",[org,[f.appointment],latest.execution])).rows[0].r).toMatchObject({resumed:true});
    expect(await sentimentContext(f,latest.message)).toEqual({owned:true});
    await pool.query("update job_queue set status='done',locked_by=null,locked_at=null where organization_id=$1 and id=$2",[org,latest.job.id]);
    expect(await sentimentContext(f,latest.message)).toEqual({owned:true});
    await newerRequest(f);
    expect(await sentimentContext(f,latest.message)).toBeNull();
  });
  it("cannot hide a finished/expired turn, a real failure, a human takeover or foreign data",async()=>{
    const f=await fixture();await finish(f);const latest=await newerRequest(f);
    expect(await sentimentContext(f,latest.message,other)).toBeNull();
    await pool.query("update job_queue set created_at=now()-interval '3 minutes' where organization_id=$1 and id=$2",[org,latest.job.id]);
    expect(await sentimentContext(f,latest.message)).toBeNull();
    await pool.query("update job_queue set created_at=now(),status='done' where organization_id=$1 and id=$2",[org,latest.job.id]);
    expect(await sentimentContext(f,latest.message)).toBeNull();
    await pool.query("update job_queue set status='running' where organization_id=$1 and id=$2",[org,latest.job.id]);
    await pool.query("update calendar_appointments set google_sync_failure_kind='human_required',google_sync_error='Fictitious failure' where organization_id=$1 and id=$2",[org,f.appointment]);
    expect(await sentimentContext(f,latest.message)).toBeNull();
    await pool.query("update calendar_appointments set google_sync_failure_kind=null,google_sync_error=null where organization_id=$1 and id=$2",[org,f.appointment]);
    await pool.query("update conversations set assigned_to_user_id=$3 where organization_id=$1 and id=$2",[org,f.conv,owner]);
    expect(await sentimentContext(f,latest.message)).toBeNull();
    expect((await pool.query("select has_function_privilege('authenticated','public.fn_google_publication_sentiment_context(uuid,uuid,uuid)','execute') allowed")).rows[0].allowed).toBe(false);
  });
});


describe("publication producer does not invert calendar and contact mutex order",()=>{
  it("commits acknowledgement without waiting on a contact transaction; native recovery enqueues once",async()=>{
    const f=await fixture();await finish(f);const holder=await pool.connect(),executor=await pool.connect();
    try{
      await holder.query('begin');
      await holder.query("select pg_advisory_xact_lock(hashtextextended($1::text||':'||$2::text,222))",[org,f.contact]);
      await executor.query('begin');await executor.query("set local statement_timeout='500ms'");
      await executor.query("select fn_calendar_service_lock($1)",[org]);
      await expect(executor.query("update calendar_appointments set google_event_id='event-'||id::text,google_synced_local_revision=google_local_revision,google_sync_error=null,google_sync_failure_kind=null where organization_id=$1 and id=$2",[org,f.appointment])).resolves.toMatchObject({rowCount:1});
      await executor.query('commit');
      expect(await queued(f)).toHaveLength(0);
      expect((await pool.query("select state from google_publication_continuations where organization_id=$1 and id=$2",[org,f.id])).rows[0].state).toBe('waiting');
    }finally{await holder.query('rollback');holder.release();await executor.query('rollback');executor.release();}
    for(let i=0;i<2;i++)await pool.query("select fn_google_continuation_enqueue($1,$2)",[org,f.id]);
    expect(await queued(f)).toHaveLength(1);
  });
});
