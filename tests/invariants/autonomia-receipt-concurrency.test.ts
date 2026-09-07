import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {seedGov,GOV_AGENT_A} from './gov-helpers';
import {replyFixture} from '../support/autonomia-fixture';
const pool=new pg.Pool({connectionString:`postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT??54329}/postgres`,max:7});
beforeAll(()=>seedGov());afterAll(()=>pool.end());
it('redação após a validação do recibo espera commit e não ressuscita preview ou mensagem',async()=>{
 const f=await replyFixture(pool),token=randomUUID(),message=randomUUID(),ledger=randomUUID();
 const draft=(await pool.query('select * from fn_reply_begin($1,$2,$3,$4,$5)',[f.org,f.conversation,f.agent,f.version,token])).rows[0];
 await pool.query("update ai_reply_drafts set status='pending',original_body='DADO PESSOAL',edited_body='DADO PESSOAL' where id=$1",[draft.id]);
 const actor=await pool.connect();let job:string;
 try{await actor.query('begin');await actor.query('set local role authenticated');await actor.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:GOV_AGENT_A,role:'authenticated',aal:'aal1'})]);job=(await actor.query("select fn_reply_action($1,$2,$3,'approve','DADO PESSOAL',null) id",[f.org,draft.id,String(draft.revision)])).rows[0].id;await actor.query('commit');}finally{actor.release();}
 const acquired=(await pool.query("update job_queue set status='running',locked_by='receipt-worker',locked_at=clock_timestamp() where id=$1 returning locked_at::text t",[job!])).rows[0].t;
 await pool.query("insert into send_ledger(id,organization_id,contact_id,job_id,seq,body_hash) values($1,$2,$3,$4,1,'hash')",[ledger,f.org,f.contact,job!]);
 await pool.query("insert into messages(id,organization_id,conversation_id,contact_id,channel_session_id,direction,type,status,body,metadata,sent_via) values($1,$2,$3,$4,$5,'outbound','text','sending','DADO PESSOAL',$6,'ai')",[message,f.org,f.conversation,f.contact,f.channel,JSON.stringify({idempotency_key:ledger})]);
 const blocker=await pool.connect(),callback=await pool.connect(),redactor=await pool.connect();
 let recognition:Promise<pg.QueryResult>|undefined,redaction:Promise<pg.QueryResult>|undefined;
 try{
  await blocker.query('begin');await blocker.query('select id from messages where id=$1 for update',[message]);
  const pid=(await callback.query('select pg_backend_pid() id')).rows[0].id;
  recognition=callback.query('select fn_reply_record_receipt($1,$2,$3,$4,$5,$6) receipt',[f.org,job!,'receipt-worker',acquired,message,'accepted-real-receipt']);
  // Wait for the callback to reach its protected message write, after its checks.
  let waiting=false;
  for(let i=0;i<100;i++){
   waiting=(await pool.query("select wait_event_type='Lock' waiting from pg_stat_activity where pid=$1",[pid])).rows[0]?.waiting===true;
   if(waiting)break;
   await pool.query('select pg_sleep(0.01)');
  }
  expect(waiting).toBe(true);
  let redacted=false;
  redaction=redactor.query('select fn_lgpd_cascade_redact_contact($1,$2,null)',[f.org,f.contact]).then(r=>{redacted=true;return r;});
  await pool.query('select pg_sleep(0.03)');expect(redacted).toBe(false);
  await blocker.query('commit');
  expect((await recognition).rows[0].receipt).toMatchObject({status:'sent',external_id:'accepted-real-receipt'});
  await redaction;
  expect(JSON.stringify((await pool.query('select body from messages where id=$1',[message])).rows[0].body)).not.toContain('DADO PESSOAL');
  expect((await pool.query('select last_message_preview from conversations where id=$1',[f.conversation])).rows[0].last_message_preview).toBeNull();
 }finally{
  await blocker.query('rollback');await recognition?.catch(()=>{});await redaction?.catch(()=>{});blocker.release();callback.release();redactor.release();
 }
});
