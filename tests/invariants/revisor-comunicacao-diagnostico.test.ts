import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {afterAll,describe,it,expect} from 'vitest';
import pg from 'pg';
import {readCurrentServiceBoundary} from '@/lib/atendimento/fronteira-server';
import {lerComunicacaoDoCaso,avisarComunicacaoPendente,reconciliarComunicacoesPendentes} from '@/lib/escalacao/comunicacao-do-caso';
import {recuperarComunicacao} from '@/lib/escalacao/recuperar-comunicacao';
import {sendWithLedger,pgSendLedger} from '@/lib/agent-engine/edge/crm/send-ledger';
if(!process.env.TEST_DB_CONTAINER)throw new Error('rode via pnpm test:db');
const pool=new pg.Pool({connectionString:`postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT??54329}/postgres`,max:5});
afterAll(()=>pool.end());
async function seed(){
  const org=randomUUID(),contact=randomUUID(),conv=randomUUID(),channel=randomUUID(),actor=randomUUID(),caseId=randomUUID(),event=randomUUID(),job=randomUUID();
  await pool.query(`insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::uuid::text,'Fixture','Fixture')`,[org]);
  await pool.query(`insert into contacts(id,organization_id,name,phone_number) values($1,$2,'Contato sintético de teste','+5511999900500')`,[contact,org]);
  await pool.query(`insert into auth.users(id,email) values($1,$2)`,[actor,actor+'@example.test']);
  await pool.query(`insert into channel_sessions(id,organization_id,waha_session_name,status,webhook_secret_encrypted) values($1::uuid,$2,$1::uuid::text,'WORKING',$3)`,[channel,org,Buffer.from([0])]);
  await pool.query(`insert into conversations(id,organization_id,contact_id,channel_session_id,status,is_group) values($1,$2,$3,$4,'ai_handling',false)`,[conv,org,contact,channel]);
  const boundary=await readCurrentServiceBoundary(pool,org,conv);
  await pool.query(`insert into agent_cases(id,organization_id,conversation_id,status,title,summary,blocker,context_snapshot) values($1,$2,$3,'resolved','Fixture','Pedido sintético','Equipe',$4)`,[caseId,org,conv,{service_boundary:boundary}]);
  await pool.query(`insert into agent_case_events(id,organization_id,case_id,kind,actor_kind,actor_user_id,human_action,body,metadata) values($1,$2,$3,'human_replied','human',$4,'resolved','Conclusão sintética original',$5)`,[event,org,caseId,actor,{review_context_v1:{versao:1,origem:'case_reply_authenticated',papel:'agent',job_id:job}}]);
  await pool.query(`insert into job_queue(id,organization_id,contact_id,kind,status,payload) values($1,$2,$3,'case_reply_turn','done',$4)`,[job,org,contact,{case_id:caseId,action:'resolved',human_event_id:event,service_boundary:boundary}]);
  return{org,contact,conv,channel,actor,caseId,event,job};
}
async function enable(f:Awaited<ReturnType<typeof seed>>,kind='job',scope=f.job){
  const {rows}=await pool.query<{data:{session_id:string}}>(`select fn_review_capture_manage($1,$2,'enable',$3,$4) as data`,[f.org,f.actor,scope,kind]);return rows[0]!.data.session_id;
}
async function capture(f:Awaited<ReturnType<typeof seed>>,text='SENTINELA_TEMPORARIA_CP005'){
  return(await pool.query<{id:string|null}>(`select fn_review_capture_append($1,$2,'reserva',$3) as id`,[f.org,f.job,{candidate:text}])).rows[0]!.id;
}
describe('T09 comunicação/recuperação persistida no mesmo Caso',()=>{
  it('Caso resolvido e job done sem envio exibem pendência e aviso deduplicado',async()=>{
    const f=await seed();expect((await lerComunicacaoDoCaso(pool,f.org,f.caseId))[0]).toMatchObject({state:'pending',delivery:null,can_retry:true});
    await avisarComunicacaoPendente(pool,f.org,f.caseId);await avisarComunicacaoPendente(pool,f.org,f.caseId);
    expect((await pool.query(`select count(*)::int as n from agent_inbox_items where organization_id=$1 and ref_id=$2`,[f.org,f.caseId])).rows[0].n).toBe(1);
    expect(await lerComunicacaoDoCaso(pool,randomUUID(),f.caseId)).toEqual([]);
  });
  it('retry concorrente reusa job/evento e só uma ação vence; a fila continua sendo dona',async()=>{
    const f=await seed(),ids={org:f.org,caseId:f.caseId,eventId:f.event,actor:f.actor,role:'agent' as const};
    const results=await Promise.allSettled([recuperarComunicacao(pool,ids,'retry'),recuperarComunicacao(pool,ids,'retry')]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect((await pool.query('select id,status from job_queue where organization_id=$1',[f.org])).rows).toEqual([{id:f.job,status:'pending'}]);
    expect((await pool.query("select count(*)::int as n from agent_case_events where organization_id=$1 and kind='human_replied'",[f.org])).rows[0].n).toBe(1);
    await expect(recuperarComunicacao(pool,ids,'retry')).rejects.toThrow();
  });
  it('retificação não apaga nota/decisão anterior, invalida cache e cria um novo evento no mesmo Caso',async()=>{
    const f=await seed(),ids={org:f.org,caseId:f.caseId,eventId:f.event,actor:f.actor,role:'agent' as const};
    const result=await recuperarComunicacao(pool,ids,'rectify','Conclusão corrigida para o mesmo pedido.');
    expect(result.event_id).not.toBe(f.event);expect(result.job_id).not.toBe(f.job);
    const rows=(await pool.query('select body,metadata from agent_case_events where organization_id=$1 and id=$2',[f.org,f.event])).rows;
    expect(rows[0].body).toBe('Conclusão sintética original');expect(rows[0].metadata.review_context_v1.revoked_at).toBeTruthy();
    expect((await pool.query('select count(*)::int as n from agent_cases where organization_id=$1',[f.org])).rows[0].n).toBe(1);
    expect((await lerComunicacaoDoCaso(pool,f.org,f.caseId))[0]).toMatchObject({event_id:result.event_id,state:'queued'});
    await expect(recuperarComunicacao(pool,ids,'retry')).rejects.toThrow();
  });
  it('fronteira/organização diferentes não autorizam retry ou retificação',async()=>{
    const f=await seed();await pool.query('update conversations set service_revision=service_revision+1 where id=$1',[f.conv]);
    await expect(recuperarComunicacao(pool,{org:f.org,caseId:f.caseId,eventId:f.event,actor:f.actor,role:'agent'},'retry')).rejects.toThrow();
    await expect(recuperarComunicacao(pool,{org:randomUUID(),caseId:f.caseId,eventId:f.event,actor:f.actor,role:'agent'},'rectify','Outro pedido')).rejects.toThrow();
  });
  it('dois jobs do mesmo evento compartilham ledger; mensagem sent é enviada, não entregue',async()=>{
    const f=await seed(),job2=randomUUID();await pool.query(`insert into job_queue(id,organization_id,contact_id,kind,status,payload) values($1,$2,$3,'case_reply_turn','done','{}')`,[job2,f.org,f.contact]);
    let calls=0;const send=async(key:string)=>{calls++;await pool.query(`insert into messages(id,organization_id,conversation_id,contact_id,channel_session_id,type,direction,status,body) values($1,$2,$3,$4,$5,'text','outbound','sent','Resposta sintética')`,[key,f.org,f.conv,f.contact,f.channel]);return{id:key,status:'sent'};};
    const input={tenantId:f.org,leadId:f.contact,jobId:f.job,seq:1,body:'Resposta sintética',humanEventId:f.event};
    expect((await sendWithLedger(pgSendLedger(pool),input,send)).kind).toBe('sent');
    expect((await sendWithLedger(pgSendLedger(pool),{...input,jobId:job2},send)).kind).toBe('already_sent');expect(calls).toBe(1);
    const state=(await lerComunicacaoDoCaso(pool,f.org,f.caseId))[0]!;expect(state).toMatchObject({state:'sent',delivery:'sent',can_retry:false});
    await expect(recuperarComunicacao(pool,{org:f.org,caseId:f.caseId,eventId:f.event,actor:f.actor,role:'agent'},'retry')).rejects.toThrow();
    await pool.query("update messages set status='delivered' where id=$1",[state.message_ids[0]]);
    expect((await lerComunicacaoDoCaso(pool,f.org,f.caseId))[0]!.delivery).toBe('delivered');
  });
  it('falha ambígua não rotaciona chave nem reenvia; ledger de outro tenant não aceita o evento',async()=>{
    const f=await seed(),other=await seed();await pool.query(`insert into send_ledger(organization_id,contact_id,job_id,seq,body_hash,status,human_event_id) values($1,$2,$3,1,'hash','failed',$4)`,[f.org,f.contact,f.job,f.event]);
    const outcome=await sendWithLedger(pgSendLedger(pool),{tenantId:f.org,leadId:f.contact,jobId:f.job,seq:1,body:'fixture',humanEventId:f.event},async()=>{throw new Error('NÃO DEVE ENVIAR');});expect(outcome.kind).toBe('failed');
    expect((await lerComunicacaoDoCaso(pool,f.org,f.caseId))[0]).toMatchObject({state:'failed',can_retry:false});
    await expect(pool.query(`insert into send_ledger(organization_id,contact_id,job_id,seq,body_hash,human_event_id) values($1,$2,$3,1,'hash',$4)`,[other.org,other.contact,other.job,f.event])).rejects.toMatchObject({code:'23503'});
  });
});
describe('T10 captura privada com RBAC/quotas/relógio/expurgo',()=>{
  it('default-off e escopo de outro tenant não coletam nem habilitam',async()=>{
    const f=await seed(),other=await seed();expect(await capture(f)).toBeNull();
    expect((await pool.query(`select fn_review_capture_manage($1,$2,'enable',$3,'job') as data`,[other.org,other.actor,f.job])).rows[0].data).toBeNull();
    const sid=await enable(f);expect(await capture(f)).not.toBeNull();
    expect((await pool.query(`select fn_review_capture_manage($1,$2,'read',null,null,$3) as data`,[other.org,other.actor,sid])).rows[0].data).toBeNull();
  });
  it('papéis públicos não acessam conteúdo nem RPC; service role lê somente pela função auditada',async()=>{
    const f=await seed(),sid=await enable(f);await capture(f);const db=await pool.connect();
    try{await db.query('set role authenticated');await expect(db.query('select * from review_capture_records')).rejects.toMatchObject({code:'42501'});
      await expect(db.query('select fn_review_capture_append($1,$2,$3,$4)',[f.org,f.job,'reserva',{}])).rejects.toMatchObject({code:'42501'});
      await db.query('reset role');await db.query('set role service_role');await expect(db.query('select * from review_capture_records')).rejects.toMatchObject({code:'42501'});
      const r=await db.query(`select fn_review_capture_manage($1,$2,'read',null,null,$3) as data`,[f.org,f.actor,sid]);expect(r.rows[0].data.records).toHaveLength(1);
    }finally{await db.query('reset role');db.release();}
    expect((await pool.query("select count(*)::int as n from api_audit_log where organization_id=$1 and action='ai.review_capture_read'",[f.org])).rows[0].n).toBe(1);
  });
  it('100 capturas concorrentes passam; a101ª fecha coleta; 10MiB é teto independente',async()=>{
    const f=await seed(),sid=await enable(f);const ids=await Promise.all(Array.from({length:101},()=>capture(f)));
    expect(ids.filter(Boolean)).toHaveLength(100);const s=(await pool.query('select reviews,enabled,stopped_reason from review_capture_sessions where id=$1',[sid])).rows[0];expect(s).toMatchObject({reviews:100,enabled:false,stopped_reason:'quota'});
    const g=await seed();await enable(g);expect(await capture(g,'x'.repeat(6*1024*1024))).not.toBeNull();expect(await capture(g,'x'.repeat(5*1024*1024))).toBeNull();
  });
  it('janela2h termina; leitura não renova TTL72h; expirado é inacessível antes do expurgo físico medido',async()=>{
    const f=await seed(),sid=await enable(f),id=await capture(f);
    const before=(await pool.query('select expires_at from review_capture_records where id=$1',[id])).rows[0].expires_at;
    await pool.query(`select fn_review_capture_manage($1,$2,'read',null,null,$3)`,[f.org,f.actor,sid]);
    expect((await pool.query('select expires_at from review_capture_records where id=$1',[id])).rows[0].expires_at).toEqual(before);
    await pool.query("update review_capture_records set captured_at=now()-interval '73 hours',expires_at=now()-interval '1 hour' where id=$1",[id]);
    expect((await pool.query(`select fn_review_capture_manage($1,$2,'read',null,null,$3) as data`,[f.org,f.actor,sid])).rows[0].data.records).toEqual([]);
    expect((await pool.query('select count(*)::int as n from review_capture_records where id=$1',[id])).rows[0].n).toBe(1);
    const purge=(await pool.query('select * from fn_review_capture_purge($1)',[f.org])).rows[0];expect(Number(purge.deleted)).toBe(1);expect(Number(purge.lag_ms)).toBeGreaterThanOrEqual(3600000);
    await pool.query("update review_capture_sessions set created_at=now()-interval '3 hours',collect_until=now()-interval '1 hour' where id=$1",[sid]);expect(await capture(f)).toBeNull();
  });
  it('expurgo atrasado interrompe coleta e avisa; revogação/anônimização removem texto',async()=>{
    const f=await seed(),sid=await enable(f);await capture(f);
    await pool.query("update review_capture_sessions set last_purged_at=now()-interval '11 minutes' where id=$1",[sid]);expect(await capture(f)).toBeNull();
    expect((await pool.query('select enabled,stopped_reason from review_capture_sessions where id=$1',[sid])).rows[0]).toMatchObject({enabled:false,stopped_reason:'purge_late'});
    expect((await pool.query('select count(*)::int as n from agent_inbox_items where organization_id=$1',[f.org])).rows[0].n).toBe(1);
    await pool.query(`select fn_review_capture_manage($1,$2,'revoke',null,null,$3)`,[f.org,f.actor,sid]);expect((await pool.query('select count(*)::int as n from review_capture_records where organization_id=$1',[f.org])).rows[0].n).toBe(0);
    await enable(f);await capture(f);await pool.query('update contacts set is_anonymized=true,anonymized_at=now() where organization_id=$1 and id=$2',[f.org,f.contact]);
    expect((await pool.query('select count(*)::int as n from review_capture_records where organization_id=$1',[f.org])).rows[0].n).toBe(0);expect(await capture(f)).toBeNull();
  });
  it('dump oficial exclui conteúdo temporário, preservando schema e auditoria sem texto',async()=>{
    const f=await seed();await enable(f);await capture(f);
    const dump=execFileSync('docker',['exec',process.env.TEST_DB_CONTAINER!,'pg_dump','-U','postgres','-d','postgres','--data-only','--table=public.review_capture_records','--exclude-table-data=public.review_capture_records'],{encoding:'utf8'});
    expect(dump).not.toContain('SENTINELA_TEMPORARIA_CP005');expect(dump).not.toContain('COPY public.review_capture_records');
    expect((await pool.query("select relpersistence from pg_class where oid='review_capture_records'::regclass")).rows[0].relpersistence).toBe('u');
  });
});


describe('laços persistidos e falhas adversas',()=>{
  it('dois jobs concorrentes não enviam duas vezes e replay deixa transação utilizável',async()=>{
    const f=await seed(),job2=randomUUID();await pool.query(`insert into job_queue(id,organization_id,contact_id,kind,status,payload) values($1,$2,$3,'case_reply_turn','done','{}')`,[job2,f.org,f.contact]);
    let entered!:()=>void,release!:()=>void,calls=0;const started=new Promise<void>(r=>entered=r),blocked=new Promise<void>(r=>release=r);
    const input={tenantId:f.org,leadId:f.contact,jobId:f.job,seq:1,body:'Resposta sintética',humanEventId:f.event};
    const first=sendWithLedger(pgSendLedger(pool),input,async(key)=>{calls++;entered();await blocked;
      await pool.query(`insert into messages(id,organization_id,conversation_id,contact_id,channel_session_id,type,direction,status,body) values($1,$2,$3,$4,$5,'text','outbound','sent','Fixture')`,[key,f.org,f.conv,f.contact,f.channel]);return{id:key,status:'sent'};});
    await started;const second=await sendWithLedger(pgSendLedger(pool),{...input,jobId:job2},async()=>{calls++;throw new Error('duplicou');});expect(second.kind).toBe('queued');release();expect((await first).kind).toBe('sent');expect(calls).toBe(1);
    const client=await pool.connect();try{await client.query('begin');expect((await sendWithLedger(pgSendLedger(client),input,async()=>{throw new Error('reenviou');})).kind).toBe('already_sent');expect((await client.query('select 1 as alive')).rows[0].alive).toBe(1);await client.query('commit');}finally{client.release();}
  });
  it('cron publica a falha após morte do worker e fecha só com mensagem real',async()=>{
    const f=await seed();await pool.query("update job_queue set status='dead' where id=$1",[f.job]);await reconciliarComunicacoesPendentes(pool);
    expect((await pool.query("select ref_kind,status from agent_inbox_items where organization_id=$1 and ref_id=$2",[f.org,f.caseId])).rows).toEqual([{ref_kind:'agent_case',status:'open'}]);
    const message=randomUUID();await pool.query(`insert into messages(id,organization_id,conversation_id,contact_id,channel_session_id,type,direction,status,body) values($1,$2,$3,$4,$5,'text','outbound','sent','Fixture')`,[message,f.org,f.conv,f.contact,f.channel]);
    await pool.query(`insert into send_ledger(organization_id,contact_id,job_id,seq,body_hash,status,human_event_id,crm_message_id) values($1,$2,$3,1,'fixture','accepted',$4,$5)`,[f.org,f.contact,f.job,f.event,message]);
    await pool.query("update job_queue set status='done' where id=$1",[f.job]);await reconciliarComunicacoesPendentes(pool);
    expect((await pool.query("select status from agent_inbox_items where organization_id=$1 and ref_id=$2",[f.org,f.caseId])).rows[0].status).toBe('resolved');
  });
  it('teto de recuperação humana é três ações, sem fabricar outro job/Caso',async()=>{
    const f=await seed(),ids={org:f.org,caseId:f.caseId,eventId:f.event,actor:f.actor,role:'agent' as const};
    for(let i=0;i<3;i++){await recuperarComunicacao(pool,ids,'retry');await pool.query("update job_queue set status='done' where id=$1",[f.job]);}
    expect((await lerComunicacaoDoCaso(pool,f.org,f.caseId))[0]).toMatchObject({manual_retries:3,can_retry:false});await expect(recuperarComunicacao(pool,ids,'retry')).rejects.toThrow();
    expect((await pool.query('select count(*)::int as n from job_queue where organization_id=$1',[f.org])).rows[0].n).toBe(1);
  });
  it('heartbeat atrasado continua desligado mesmo quando o cron finalmente expurga',async()=>{
    const f=await seed(),sid=await enable(f);await pool.query("update review_capture_sessions set last_purged_at=now()-interval '11 minutes' where id=$1",[sid]);await pool.query('select * from fn_review_capture_purge($1)',[f.org]);
    expect((await pool.query('select enabled,stopped_reason from review_capture_sessions where id=$1',[sid])).rows[0]).toMatchObject({enabled:false,stopped_reason:'purge_late'});expect(await capture(f)).toBeNull();
    expect((await pool.query("select kind from agent_inbox_items where organization_id=$1 and status='open'",[f.org])).rows).toEqual([{kind:'review_capture_stopped'}]);
  });
  it('falha de auditoria de leitura bloqueia conteúdo e não renova prazo',async()=>{
    const f=await seed(),sid=await enable(f);await capture(f);const before=(await pool.query('select expires_at from review_capture_records where session_id=$1',[sid])).rows[0].expires_at;
    await pool.query(`create function public.cp005_audit_failure() returns trigger language plpgsql as $$begin if NEW.action='ai.review_capture_read' and NEW.organization_id='${f.org}'::uuid then raise exception 'audit unavailable'; end if; return NEW; end$$;create trigger cp005_audit_failure before insert on api_audit_log for each row execute function cp005_audit_failure()`);
    try{await expect(pool.query(`select fn_review_capture_manage($1,$2,'read',null,null,$3)`,[f.org,f.actor,sid])).rejects.toThrow('audit unavailable');expect((await pool.query('select expires_at from review_capture_records where session_id=$1',[sid])).rows[0].expires_at).toEqual(before);}finally{await pool.query('drop trigger cp005_audit_failure on api_audit_log;drop function public.cp005_audit_failure()');}
  });
  it('migration idempotente preserva captura e vocabulário já gravados',async()=>{
    const f=await seed();await enable(f);await capture(f);await pool.query(`insert into agent_inbox_items(organization_id,kind,severity,title,body) values($1,'review_capture_stopped','warn','Fixture','Fixture')`,[f.org]);
    await pool.query(readFileSync('supabase/migrations/20261020231734_0717_comunicacao_e_diagnostico_da_revisao.sql','utf8'));
    expect((await pool.query('select count(*)::int as n from review_capture_records where organization_id=$1',[f.org])).rows[0].n).toBe(1);expect((await pool.query('select kind from agent_inbox_items where organization_id=$1',[f.org])).rows[0].kind).toBe('review_capture_stopped');
  });
});


describe('comunicação legada e deduplicação por decisão',()=>{
  it('mesmo evento não recria aviso que a pessoa encerrou; Caso permanece pendente',async()=>{
    const f=await seed();await avisarComunicacaoPendente(pool,f.org,f.caseId);await pool.query("update agent_inbox_items set status='resolved',resolved_at=now() where organization_id=$1",[f.org]);await avisarComunicacaoPendente(pool,f.org,f.caseId);await reconciliarComunicacoesPendentes(pool);
    expect((await pool.query('select count(*)::int as n from agent_inbox_items where organization_id=$1',[f.org])).rows[0].n).toBe(1);expect((await lerComunicacaoDoCaso(pool,f.org,f.caseId))[0]!.state).toBe('pending');
  });
  it('job morto após envio comprovado não torna a comunicação uma falha',async()=>{
    const f=await seed(),message=randomUUID();await pool.query(`insert into messages(id,organization_id,conversation_id,contact_id,channel_session_id,type,direction,status,body) values($1,$2,$3,$4,$5,'text','outbound','sent','Fixture')`,[message,f.org,f.conv,f.contact,f.channel]);
    await pool.query(`insert into send_ledger(organization_id,contact_id,job_id,seq,body_hash,status,human_event_id,crm_message_id) values($1,$2,$3,1,'fixture','accepted',$4,$5)`,[f.org,f.contact,f.job,f.event,message]);await pool.query("update job_queue set status='dead' where id=$1",[f.job]);
    expect((await lerComunicacaoDoCaso(pool,f.org,f.caseId))[0]).toMatchObject({state:'sent',delivery:'sent',partial:false,can_retry:false});
  });
  it('legado sem job não fabrica envio/autoridade; decisão nova pode retificar no mesmo Caso com fronteira comprovada',async()=>{
    const f=await seed();await pool.query("update agent_case_events set metadata='{}' where id=$1",[f.event]);
    expect((await lerComunicacaoDoCaso(pool,f.org,f.caseId))[0]).toMatchObject({state:'unknown_legacy',can_retry:false,can_rectify:true});
    const result=await recuperarComunicacao(pool,{org:f.org,caseId:f.caseId,eventId:f.event,actor:f.actor,role:'agent'},'rectify','Nova decisão humana explícita para o pedido atual.');
    expect(result.event_id).not.toBe(f.event);expect((await pool.query('select count(*)::int as n from agent_cases where organization_id=$1',[f.org])).rows[0].n).toBe(1);
  });
});

describe('Retenção e reconciliação continuam internas na organização suspensa',()=>{
  it('expurga conteúdo vencido e registra pendência sem criar job ou mensagem',async()=>{
    const f=await seed();await enable(f);const id=await capture(f);
    await pool.query("update organizations set status='suspended',suspended_kind='administrativa' where id=$1",[f.org]);
    expect((await pool.query('select fn_org_operante($1) as active',[f.org])).rows[0].active).toBe(false);
    await pool.query("update review_capture_records set captured_at=now()-interval '73 hours',expires_at=now()-interval '1 hour' where id=$1",[id]);
    const deleted=(await pool.query('select * from fn_review_capture_purge($1)',[f.org])).rows[0].deleted;
    expect(Number(deleted)).toBe(1);
    expect((await pool.query('select count(*)::int as n from review_capture_records where organization_id=$1',[f.org])).rows[0].n).toBe(0);
    await reconciliarComunicacoesPendentes(pool);await reconciliarComunicacoesPendentes(pool);
    expect((await pool.query("select count(*)::int as n from agent_inbox_items where organization_id=$1 and ref_kind='agent_case' and ref_id=$2",[f.org,f.caseId])).rows[0].n).toBe(1);
    expect((await pool.query('select id,status from job_queue where organization_id=$1',[f.org])).rows).toEqual([{id:f.job,status:'done'}]);
    expect((await pool.query('select count(*)::int as n from send_ledger where organization_id=$1',[f.org])).rows[0].n).toBe(0);
    expect((await pool.query('select count(*)::int as n from messages where organization_id=$1',[f.org])).rows[0].n).toBe(0);
  });
});


describe('Captura exige a porta auditada; RLS não serve tabelas diretamente',()=>{
  it('nega papéis diretos e isola dois tenants por JWT mesmo diante de grant acidental',async()=>{
    const a=await seed(),b=await seed();
    const sa=await enable(a),sb=await enable(b);await capture(a,'SENTINELA_A');await capture(b,'SENTINELA_B');
    for(const f of [a,b])await pool.query("insert into user_organizations(user_id,organization_id,role,accepted_at) values($1,$2,'admin',now())",[f.actor,f.org]);
    for(const table of ['review_capture_sessions','review_capture_records']){
      expect((await pool.query(`select count(*)::int as n from ${table} where organization_id=any($1::uuid[])`,[[a.org,b.org]])).rows[0].n).toBe(2);
      expect((await pool.query(`select count(*)::int as n from pg_policies where schemaname='public' and tablename=$1 and permissive='PERMISSIVE'`,[table])).rows[0].n).toBe(0);
    }
    const db=await pool.connect();
    try{
      for(const role of ['anon','authenticated','service_role']){
        await db.query(`set role ${role}`);
        for(const table of ['review_capture_sessions','review_capture_records'])await expect(db.query(`select * from ${table}`)).rejects.toMatchObject({code:'42501'});
        if(role!=='service_role')await expect(db.query("select fn_review_capture_manage($1,$2,'read',null,null,$3)",[a.org,a.actor,sa])).rejects.toMatchObject({code:'42501'});
        else{
          expect((await db.query("select fn_review_capture_manage($1,$2,'read',null,null,$3) as data",[a.org,a.actor,sa])).rows[0].data.records).toHaveLength(1);
          expect((await db.query("select fn_review_capture_manage($1,$2,'read',null,null,$3) as data",[a.org,a.actor,sb])).rows[0].data).toBeNull();
        }
        await db.query('reset role');
      }
      await db.query('begin');
      await db.query('grant select on review_capture_sessions,review_capture_records to authenticated');
      await db.query('set local role authenticated');
      for(const f of [a,b]){
        await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:f.actor})]);
        expect((await db.query('select fn_user_org_ids() as org')).rows).toEqual([{org:f.org}]);
        for(const table of ['review_capture_sessions','review_capture_records'])expect((await db.query(`select count(*)::int as n from ${table}`)).rows[0].n).toBe(0);
      }
    }finally{await db.query('rollback');await db.query('reset role');db.release();}
    expect((await pool.query("select has_table_privilege('authenticated','review_capture_records','SELECT') as allowed")).rows[0].allowed).toBe(false);
  });
});


describe('A janela de captura nasce de um unico instante',()=>{
  it('nao depende da ordem de avaliacao de defaults volateis nem relaxa as duas horas',async()=>{
    const f=await seed(),db=await pool.connect();
    try{
      await db.query('begin');
      // Controle deterministico do defeito: o default captura o inicio e demora antes do prazo.
      await db.query(`create function pg_temp.capture_delayed_default() returns timestamptz language plpgsql as $$
        declare instant timestamptz:=clock_timestamp(); begin perform pg_sleep(0.02); return instant; end $$`);
      await db.query('alter table review_capture_sessions alter column created_at set default pg_temp.capture_delayed_default()');
      const result=(await db.query("select fn_review_capture_manage($1,$2,'enable',$3,'job') as data",[f.org,f.actor,f.job])).rows[0].data;
      expect(result).toMatchObject({enabled:true,session_id:expect.any(String)});
      const row=(await db.query('select extract(epoch from collect_until-created_at)::int as seconds,last_purged_at=created_at as same_instant from review_capture_sessions where id=$1',[result.session_id])).rows[0];
      expect(row).toEqual({seconds:7200,same_instant:true});
    }finally{await db.query('rollback');db.release();}
  });
});
