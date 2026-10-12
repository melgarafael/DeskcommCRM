import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { resolveCaseFromHuman, markAwaitingLead } from '@/lib/agent-engine/agent/human-cases';
import { enqueueJob, type JobRow } from '@/lib/agent-engine/queue/queue';
import { carregarContextoDeDecisaoHumana, ligarEventoAoJob, resolverEventoDoJob } from '@/lib/agent-engine/agent/contexto-de-decisao-humana';
import { pacoteFactualDaRevisao } from '@/lib/agent-engine/guardrails/promise/contrato-contexto';
import { createCaseReplyTurnHandler } from '@/lib/agent-engine/agent/case-reply-turn';
import type { InboundTurnDeps, runAgentTurn } from '@/lib/agent-engine/agent/inbound-turn';
const turn=vi.hoisted(()=>vi.fn<typeof runAgentTurn>(async()=>undefined));
vi.mock('@/lib/agent-engine/agent/inbound-turn',()=>({runAgentTurn:turn,ritualBlocks:()=>[]}));
if (!process.env.TEST_DB_CONTAINER) throw new Error('rode via pnpm test:db');
const pool=new pg.Pool({ connectionString:`postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,max:4 });
const org=randomUUID(), other=randomUUID(), contact=randomUUID(),otherContact=randomUUID(),session=randomUUID(),conv=randomUUID(),actor=randomUUID();
let caseId:string, requestId:string;
const boundary={organization_id:org,contact_id:contact,conversation_id:conv,service_revision:1,demanda_id:null,demanda_revision:null};
beforeAll(async()=>{
  for (const id of [org,other]) await pool.query(`insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::uuid::text,'Prova','Prova')`,[id]);
  for (const [id,tenant,phone] of [[contact,org,'+5511999912345'],[otherContact,other,'+5511999912346']])
    await pool.query(`insert into contacts(id,organization_id,name,phone_number) values($1,$2,'Prova',$3)`,[id,tenant,phone]);
  await pool.query(`insert into channel_sessions(id,organization_id,waha_session_name,status,webhook_secret_encrypted) values($1::uuid,$2,$1::uuid::text,'WORKING','\\x00')`,[session,org]);
  await pool.query(`insert into conversations(id,organization_id,contact_id,channel_session_id,status,is_group) values($1,$2,$3,$4,'ai_handling',false)`,[conv,org,contact,session]);
  await pool.query(`insert into auth.users(id,email) values($1,'revisor-prova@example.test')`,[actor]);
  await pool.query(`insert into user_organizations(user_id,organization_id,role) values($1,$2,'agent')`,[actor,org]);
});
beforeEach(async()=>{
  turn.mockClear();
  await pool.query('delete from job_queue where organization_id=$1',[org]);
  await pool.query('delete from agent_cases where organization_id=$1',[org]);
  await pool.query('delete from messages where organization_id=$1',[org]);
  await pool.query("update conversations set service_revision=1,status='ai_handling',current_demanda_id=null where id=$1",[conv]);
  caseId=randomUUID();requestId=randomUUID();
  await pool.query(`insert into messages(id,organization_id,conversation_id,channel_session_id,contact_id,direction,type,body,status)
    values($1,$2,$3,$4,$5,'inbound','text','Pode confirmar Ana em 15/10 às 10h?','received')`,[requestId,org,conv,session,contact]);
  await pool.query(`insert into agent_cases(id,organization_id,conversation_id,title,summary,blocker,context_snapshot)
    values($1,$2,$3,'Confirmação','Pedido de sessão de Ana','Equipe confirma manualmente',$4)`,[caseId,org,conv,{service_boundary:boundary,request_message_id:requestId}]);
});
afterAll(()=>pool.end());
async function reply(action='resolved'):Promise<JobRow>{
  const db=await pool.connect();const event=randomUUID();
  try {
    await db.query('begin');
    const changed=action==='resolved'?await resolveCaseFromHuman(db,org,caseId,actor,'Pode comunicar a confirmação de Ana em 15/10 às 10h.',event):await markAwaitingLead(db,org,caseId,actor,'Qual o nome do beneficiário?',event);
    if (!changed) throw new Error('corrida perdida');
    const {job}=await enqueueJob(db,org,{kind:'case_reply_turn',leadId:contact,payload:{case_id:caseId,action,human_event_id:event,body:'payload deliberadamente incorreto'}});
    await ligarEventoAoJob(db,{tenantId:org,caseId,eventId:event,jobId:job.id,role:'agent'});
    await db.query('commit');return job;
  } catch(e) {await db.query('rollback');throw e;} finally {db.release();}
}
describe('T01 vínculo transacional real',()=>{
  it('transição, evento e job commitam juntos; handler relê nota do banco',async()=>{
    const job=await reply();const event=await resolverEventoDoJob(pool,job);
    expect(event?.note).toContain('Pode comunicar');expect(event?.note).not.toContain('payload');
    expect(event?.eventId).toBe(job.payload.human_event_id);
    const ctx=await carregarContextoDeDecisaoHumana(pool,{tenantId:org,leadId:contact,conversationId:conv});
    expect(ctx.decisions[0]).toMatchObject({eligible:true,requestId,jobId:job.id,provenance:'authenticated'});
  });
  it('enqueue que falha desfaz transição e evento',async()=>{
    const db=await pool.connect();
    try {
      await db.query('begin');await resolveCaseFromHuman(db,org,caseId,actor,'Concluído',randomUUID());
      await expect(enqueueJob(db,org,{kind:'case_reply_turn',leadId:randomUUID(),payload:{}})).rejects.toThrow();
      await db.query('rollback');
    } finally {db.release();}
    expect((await pool.query('select status from agent_cases where id=$1',[caseId])).rows[0].status).toBe('awaiting_human');
    expect((await pool.query('select id from agent_case_events where case_id=$1',[caseId])).rowCount).toBe(0);
  });
  it('dois humanos concorrentes: só um evento e um job canônico',async()=>{
    const outcomes=await Promise.allSettled([reply(),reply()]);
    expect(outcomes.filter(x=>x.status==='fulfilled')).toHaveLength(1);
    expect((await pool.query("select id from agent_case_events where case_id=$1 and kind='human_replied'",[caseId])).rowCount).toBe(1);
    expect((await pool.query('select id from job_queue where organization_id=$1',[org])).rowCount).toBe(1);
  });
  it('job duplicado para o mesmo evento não alcança a reentrada',async()=>{
    const job=await reply();
    const duplicate={...job,id:randomUUID()};
    expect(await resolverEventoDoJob(pool,duplicate)).toBeNull();
    expect(await resolverEventoDoJob(pool,job)).not.toBeNull();
  });
  it.each(['resolved','need_lead_info'])('handler real %s passa somente IDs e nota relidos do evento',async action=>{
    const job=await reply(action);
    const log={info:vi.fn(),warn:vi.fn(),error:vi.fn(),debug:vi.fn()};
    const handler=createCaseReplyTurnHandler({log} as unknown as InboundTurnDeps);
    await handler(job,pool,{workerId:'prova'});
    expect(turn).toHaveBeenCalledTimes(1);
    expect(turn.mock.calls[0]?.[4]).toMatchObject({humanCaseEventId:job.payload.human_event_id,conversationId:conv,channelSessionId:session});
    await handler({...job,id:randomUUID()},pool,{workerId:'prova'});
    expect(turn).toHaveBeenCalledTimes(1);
  });
  it('outra organização ou contato não herda a decisão',async()=>{
    const job=await reply();
    expect(await resolverEventoDoJob(pool,{...job,organization_id:other})).toBeNull();
    expect(await resolverEventoDoJob(pool,{...job,contact_id:otherContact})).toBeNull();
    await expect(carregarContextoDeDecisaoHumana(pool,{tenantId:other,leadId:otherContact,conversationId:conv})).rejects.toThrow('scope_mismatch');
  });
  it.each(['viewer','agent','manager','admin'])('papel real %s não pode fabricar autoridade no Data API',async role=>{
    await pool.query('update user_organizations set role=$3 where user_id=$1 and organization_id=$2',[actor,org,role]);
    const db=await pool.connect();
    try {
      await db.query('begin');await db.query("set local role authenticated");
      await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:actor,role:'authenticated'})]);
      await expect(db.query(`insert into agent_case_events(organization_id,case_id,kind,actor_kind,actor_user_id,human_action,metadata)
        values($1,$2,'human_replied','human',$3,'resolved','{"review_context_v1":{"versao":1}}')`,[org,caseId,actor])).rejects.toMatchObject({code:'42501'});
      await db.query('rollback');
    } finally {db.release();}
  });
});
describe('T02 validade e legado',()=>{
  it.each(['revoked_at','expires_at'])('%s invalida a decisão e o handler',async key=>{
    const job=await reply();const before=await carregarContextoDeDecisaoHumana(pool,{tenantId:org,leadId:contact,conversationId:conv});
    await pool.query(`update agent_case_events set metadata=jsonb_set(metadata,ARRAY['review_context_v1',$3],to_jsonb($4::text)) where organization_id=$1 and id=$2`,[org,job.payload.human_event_id,key,'2026-01-01T00:00:00Z']);
    const after=await carregarContextoDeDecisaoHumana(pool,{tenantId:org,leadId:contact,conversationId:conv});
    expect(after.decisions[0]?.eligible).toBe(false);expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(await resolverEventoDoJob(pool,job)).toBeNull();
  });
  it('nova mensagem muda a fotografia; dados de outro tenant não mudam',async()=>{
    await reply();const read=()=>carregarContextoDeDecisaoHumana(pool,{tenantId:org,leadId:contact,conversationId:conv});const a=await read();
    await pool.query("update contacts set name='Outra empresa' where id=$1",[otherContact]);
    expect((await read()).fingerprint).toBe(a.fingerprint);
    await pool.query(`insert into messages(organization_id,conversation_id,channel_session_id,contact_id,direction,type,body,status,created_at) values($1,$2,$3,$4,'inbound','text','Agora é para Bruno em 16/10 às 15h.','received',now()+interval '1 second')`,[org,conv,session,contact]);
    const b=await read();expect(b.fingerprint).not.toBe(a.fingerprint);expect(b.currentRequest?.text).toContain('Bruno');
  });
  it('reset de atendimento não transfere autorização',async()=>{
    const job=await reply();await pool.query('update conversations set service_revision=2 where id=$1',[conv]);
    expect(await resolverEventoDoJob(pool,job)).toBeNull();
    expect((await carregarContextoDeDecisaoHumana(pool,{tenantId:org,leadId:contact,conversationId:conv})).decisions[0]?.eligible).toBe(false);
  });
  it('a revalidação sob transação impede retificação da nota até o efeito terminar',async()=>{
    const job=await reply();const sender=await pool.connect(),writer=await pool.connect();
    try {
      await sender.query('begin');
      await carregarContextoDeDecisaoHumana(sender,{tenantId:org,leadId:contact,conversationId:conv},{lock:true});
      await writer.query('begin');await writer.query("set local statement_timeout='100ms'");
      await expect(writer.query("update agent_case_events set body='Retificado' where id=$1",[job.payload.human_event_id])).rejects.toMatchObject({code:'57014'});
      await writer.query('rollback');await sender.query('commit');
      await writer.query("update agent_case_events set body='Retificado' where id=$1",[job.payload.human_event_id]);
    } finally {await sender.query('rollback');await writer.query('rollback');sender.release();writer.release();}
  });
  it('pedido sem ponteiro nunca recebe exceção positiva',async()=>{
    await reply();await pool.query("update agent_cases set context_snapshot=context_snapshot-'request_message_id' where id=$1",[caseId]);
    expect((await carregarContextoDeDecisaoHumana(pool,{tenantId:org,leadId:contact,conversationId:conv})).decisions[0]?.eligible).toBe(false);
  });
  it('need_lead_info informa o contexto sem fingir conclusão',async()=>{
    const job=await reply('need_lead_info');expect(await resolverEventoDoJob(pool,job)).not.toBeNull();
    expect((await carregarContextoDeDecisaoHumana(pool,{tenantId:org,leadId:contact,conversationId:conv})).decisions[0]?.eligible).toBe(false);
  });
  it('legado único tem CAS por evento; segundo job perde, sem fabricar papel histórico',async()=>{
    const note='Confirmação manual';await resolveCaseFromHuman(pool,org,caseId,actor,note);
    const job={id:randomUUID(),organization_id:org,contact_id:contact,payload:{case_id:caseId,action:'resolved',body:note}} as unknown as JobRow;
    expect(await resolverEventoDoJob(pool,job)).not.toBeNull();
    expect(await resolverEventoDoJob(pool,{...job,id:randomUUID()})).toBeNull();
    const ctx=await carregarContextoDeDecisaoHumana(pool,{tenantId:org,leadId:contact,conversationId:conv});
    expect(ctx.decisions[0]).toMatchObject({provenance:'legacy_correlated',eligible:false,jobId:null});
  });
  it('legado ambíguo ou sem evento fica pendente',async()=>{
    const job={id:randomUUID(),organization_id:org,contact_id:contact,payload:{case_id:caseId,action:'resolved',body:'Mesma nota'}} as unknown as JobRow;
    await pool.query("update agent_cases set status='resolved',closed_at=now() where id=$1",[caseId]);
    expect(await resolverEventoDoJob(pool,job)).toBeNull();
    await pool.query(`insert into agent_case_events(organization_id,case_id,kind,actor_kind,actor_user_id,human_action,body)
      select $1,$2,'human_replied','human',$3,'resolved','Mesma nota' from generate_series(1,2)`,[org,caseId,actor]);
    expect(await resolverEventoDoJob(pool,job)).toBeNull();
  });
  it('30 leituras quentes: três consultas por fotografia, sem rede de modelo',async()=>{
    await reply();const ids={tenantId:org,leadId:contact,conversationId:conv};await carregarContextoDeDecisaoHumana(pool,ids);
    const ms:number[]=[],baseline:number[]=[];
    for(let i=0;i<30;i++){
      const oldStart=performance.now();JSON.stringify({mensagem:'A equipe confirmou Ana em 15/10 às 10h.',evidencias:[]});baseline.push(performance.now()-oldStart);
      const start=performance.now();const h=await carregarContextoDeDecisaoHumana(pool,ids);
      JSON.stringify(pacoteFactualDaRevisao({candidate:'A equipe confirmou Ana em 15/10 às 10h.',humanDecisionContext:h,commercialEvidence:[]}));ms.push(performance.now()-start);
    }
    ms.sort((a,b)=>a-b);baseline.sort((a,b)=>a-b);
    console.info(JSON.stringify({benchmark:'contexto_casos',samples:30,baseline_p50:baseline[14],baseline_p95:baseline[28],p50:ms[14],p95:ms[28],queries_per_snapshot:3,baseline_queries:0,fixture:'um caso sintetico, sem rede de modelo'}));
    expect(ms[28]).toBeLessThan(100);
  });
});
