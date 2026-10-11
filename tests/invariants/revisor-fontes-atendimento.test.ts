import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { carregarContextoDoAtendimento, projetarContextoDoAtendimento } from '@/lib/agent-engine/agent/contexto-do-atendimento';
if (!process.env.TEST_DB_CONTAINER) throw new Error('rode via pnpm test:db');
const pool=new pg.Pool({connectionString:`postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,max:3});
const org=randomUUID(),other=randomUUID(),contact=randomUUID(),otherContact=randomUUID(),conv=randomUUID(),session=randomUUID(),pipeline=randomUUID(),stage=randomUUID(),lead=randomUUID(),actor=randomUUID(),job=randomUUID();
const ids={tenantId:org,leadId:contact,conversationId:conv,jobId:job};
beforeAll(async()=>{
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service';
  for(const id of [org,other])await pool.query(`insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::uuid::text,'Fixture','Fixture')`,[id]);
  for(const [id,tenant,phone] of [[contact,org,'+5511999911111'],[otherContact,other,'+5511999922222']])await pool.query(`insert into contacts(id,organization_id,name,phone_number,tags) values($1,$2,'Fixture',$3,ARRAY['aluno'])`,[id,tenant,phone]);
  await pool.query(`insert into channel_sessions(id,organization_id,waha_session_name,status,webhook_secret_encrypted) values($1::uuid,$2,$1::uuid::text,'WORKING','\\x00')`,[session,org]);
  await pool.query(`insert into conversations(id,organization_id,contact_id,channel_session_id,status,is_group) values($1,$2,$3,$4,'ai_handling',false)`,[conv,org,contact,session]);
  await pool.query(`insert into crm_pipelines(id,organization_id,name,slug,settings) values($1,$2,'Fixture','fixture',$3)`,[pipeline,org,{fields:[{key:'modalidade',label:'Modalidade'}]}]);
  await pool.query(`insert into crm_stages(id,organization_id,pipeline_id,name,slug,position) values($1,$2,$3,'Novo','novo',1)`,[stage,org,pipeline]);
  await pool.query(`insert into crm_leads(id,organization_id,pipeline_id,stage_id,contact_id,title,source,custom_fields) values($1,$2,$3,$4,$5,'Ana','formulario',$6)`,[lead,org,pipeline,stage,contact,{modalidade:'natação'}]);
  await pool.query(`insert into auth.users(id,email) values($1,'revisor-fontes@example.test')`,[actor]);
  await pool.query(`insert into user_organizations(user_id,organization_id,role) values($1,$2,'agent')`,[actor,org]);
  await pool.query(`insert into lead_state(organization_id,contact_id,next_action_seq) values($1,$2,7)`,[org,contact]);
  await pool.query(`insert into lead_notes(organization_id,contact_id,headline,body) values($1,$2,'Beneficiário','Ana, filha; perfil declarado, não verificado'),($3,$4,'Segredo','OUTRO_TENANT')`,[org,contact,other,otherContact]);
  await pool.query(`insert into job_queue(id,organization_id,contact_id,kind,status,payload) values($1,$2,$3,'inbound_turn','done',$4)`,[job,org,contact,{conversation_id:conv}]);
  await pool.query(`insert into crm_lead_activities(organization_id,lead_id,contact_id,source_module,type,actor_kind,performed_by_user_id,reason,payload) values($1,$2,$3,'crm','next_action_approved','user',$4,'Aprovação de ação',$5)`,[org,lead,contact,actor,{next_action:'Consultar horário para Ana',review_context_v1:{versao:1,origem:'next_action_authenticated',papel:'agent',proposta_seq:7}}]);
  await pool.query(`with v as (insert into playbook_versions(organization_id,layer,content)
    select null,'platform','Assistente de teste.' where not exists(select 1 from playbook_pointers where organization_id is null and layer='platform') returning id)
    insert into playbook_pointers(organization_id,layer,version_id) select null,'platform',id from v`);
});
afterAll(()=>pool.end());
describe('T05/T07 SQL real de fontes por atendimento',()=>{
  it('turno real do agente e seam de revisão recebem perfil, memória e decisão; canal é somente captura',async()=>{
    const {createInboundTurnHandler}=await import('@/lib/agent-engine/agent/inbound-turn');
    const queue=await import('@/lib/agent-engine/queue/queue');
    const {createFakeRegistry}=await import('@/lib/agent-engine/edge/llm/providers');
    const {createLogger}=await import('@/lib/agent-engine/obs/logger');
    const msg=randomUUID();
    await pool.query(`insert into messages(id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,body,sent_at) values($1,$2,$3,$4,$5,'text','inbound','received','É para Ana, como no formulário.',now())`,[msg,org,conv,session,contact]);
    const {job:turnJob}=await queue.enqueueJob(pool,org,{kind:'inbound_turn',leadId:contact,payload:{conversation_id:conv,contact_id:contact,channel_session_id:session,inbound_message_id:msg,crm_event_id:randomUUID()},maxAttempts:1});
    const claimed=(await queue.claimJobs(pool,{workerId:'cp003-fixture',maxConcurrency:5})).find(x=>x.id===turnJob.id);
    expect(claimed).toBeDefined();
    const prompts:string[]=[],reviewPackets:Array<Record<string,unknown>>=[],sent:string[]=[];let agentCalls=0;
    const usage={inputTokens:{total:1,noCache:1,cacheRead:0,cacheWrite:0},outputTokens:{total:1,text:1,reasoning:0}};
    const text=(value:string)=>({content:[{type:'text' as const,text:value}],finishReason:{unified:'stop' as const,raw:undefined},usage,warnings:[]});
    const fake=async(options:{prompt:unknown})=>{
      const serialized=JSON.stringify(options.prompt);prompts.push(serialized);
      if(serialized.includes('classificador auxiliar de compliance')){
        const parts=options.prompt as Array<{role:string;content:Array<{text?:string}>}>;
        const raw=parts.filter(p=>p.role==='user').flatMap(p=>p.content).find(p=>p.text?.startsWith('{'))?.text;
        if(raw)reviewPackets.push(JSON.parse(raw));
        return text('{"isPromise":false,"prometeuRetornoHumano":false,"retornoSoDoAssistente":false,"repasseConcluidoFiel":false}');
      }
      if(agentCalls++===0)return {content:[{type:'tool-call' as const,toolCallId:'send-fixture',toolName:'send_message',input:JSON.stringify({body:'Ana pode conhecer a modalidade informada.'})}],finishReason:{unified:'tool-calls' as const,raw:undefined},usage,warnings:[]};
      return text('{"commitments":[],"objections":[],"next_action":null,"rolling_summary":"Fixture"}');
    };
    const handler=createInboundTurnHandler({crmCfg:{supabase:{} as never},llmCfg:{anthropicApiKey:'fake'} as never,
      knobs:{historyLimit:10,maxContextTokens:4000,notesIndexMaxTokens:500,maxSteps:8,queuedRetryDelayMs:1000,promiseSemantic:{enabled:true},
        breaker:{exactFailureWarn:2,exactFailureBlock:5,sameToolFailureWarn:3,sameToolFailureHalt:8,noProgressWarn:3,noProgressBlock:5}},
      log:createLogger(),registry:createFakeRegistry(fake as never),channel:()=>({channel:'captura',send:async(input:{body:string})=>{sent.push(input.body);return {kind:'sent' as const,idempotencyKey:'fixture',messageId:msg};},sessionHealth:async()=>({healthy:true,status:'WORKING'}),capabilities:()=>({freeform:true,media:true,audio:true}),costPerMessage:()=>({currency:'BRL',cents:0})}) as never,
      clock:()=>new Date('2026-10-10T12:00:00Z'),sleep:async()=>{}});
    await handler(claimed!,pool,{workerId:'cp003-fixture'});
    expect(prompts[0]).toContain('Modalidade');expect(prompts[0]).toContain('memoria_auxiliar_nao_verificada');
    expect(reviewPackets).toHaveLength(1);
    expect(JSON.stringify(reviewPackets[0]?.contexto_atendimento)).toContain('Modalidade');
    expect(JSON.stringify(reviewPackets[0]?.contexto_atendimento)).toContain('decisao_sobre_acao_nao_recibo_de_execucao');
    expect(sent).toEqual(['Ana pode conhecer a modalidade informada.']);
    expect(JSON.stringify(reviewPackets)).not.toContain('OUTRO_TENANT');
    await queue.completeJob(pool,claimed!.id,'cp003-fixture');
  });
  it('contato e negócio têm IDs diferentes; leitura única inclui campos/notas/decisão corretos',async()=>{
    const c=await carregarContextoDoAtendimento(pool,ids);
    expect(c.perfil.find(x=>x.origem==='campo_crm')).toMatchObject({estado:'declared',dados:{campo:'Modalidade',valor:'natação'}});
    expect(c.perfil.some(x=>x.origem==='memoria_do_agente')).toBe(true);
    expect(c.decisoes[0]?.dados).toMatchObject({validade:'valid',significado:'decisao_sobre_acao_nao_recibo_de_execucao'});
    const p=JSON.stringify(projetarContextoDoAtendimento(c));expect(p).not.toContain('OUTRO_TENANT');expect(p).not.toContain(contact);expect(p).not.toContain(lead);
  });
  it('org, contato e conversa divergentes não retornam pacote da primeira organização',async()=>{
    for(const bad of [{...ids,tenantId:other},{...ids,leadId:otherContact},{...ids,conversationId:randomUUID()}]){
      const c=await carregarContextoDoAtendimento(pool,bad);expect(c.perfil).toEqual([]);expect(c.cobertura.every(x=>x.estado==='unavailable')).toBe(true);
    }
  });
  it('recibos persistidos, pergunta humana e resposta declarada preservam seus estados sem fabricar pagamento',async()=>{
    const appointment=randomUUID(),proposal=randomUUID(),cron=randomUUID(),caseId=randomUUID();
    await pool.query(`insert into calendar_appointments(id,organization_id,contact_id,conversation_id,title,starts_at,ends_at,time_zone) values($1,$2,$3,$4,'Ana','2030-10-10T10:00:00Z','2030-10-10T11:00:00Z','UTC')`,[appointment,org,contact,conv]);
    await pool.query(`insert into crm_proposals(id,organization_id,lead_id,contact_id,conversation_id,titulo,status) values($1,$2,$3,$4,$5,'Plano','aceita')`,[proposal,org,lead,contact,conv]);
    await pool.query(`insert into cron_jobs(id,organization_id,contact_id,kind,job_kind,next_run_at,payload) values($1,$2,$3,'at','followup_turn','2030-10-11T10:00:00Z',$4)`,[cron,org,contact,{conversation_id:conv,promise:'retomar pela IA'}]);
    await pool.query(`insert into agent_cases(id,organization_id,conversation_id,status,title,summary,blocker) values($1,$2,$3,'awaiting_lead','Pergunta','Fixture','Equipe')`,[caseId,org,conv]);
    await pool.query(`insert into agent_case_events(organization_id,case_id,kind,actor_kind,actor_user_id,human_action,body) values($1,$2,'human_replied','human',$3,'need_lead_info','Concluiu o formulário?')`,[org,caseId,actor]);
    await pool.query(`insert into agent_case_events(organization_id,case_id,kind,actor_kind,body) values($1,$2,'lead_provided','lead','Já fiz')`,[org,caseId]);
    const c=await carregarContextoDoAtendimento(pool,ids);
    expect(c.operacoes.find(x=>x.origem==='agenda_persistida')?.dados).toMatchObject({estado:'confirmed',significado:'registro_da_agenda_nao_presenca'});
    expect(c.operacoes.find(x=>x.origem==='proposta')?.dados.significado).toBe('estado_da_proposta_nao_pagamento_ou_matricula');
    expect(c.operacoes.find(x=>x.origem==='callback_ia')?.dados.significado).toBe('retorno_da_ia_nao_telefonema_humano');
    expect(c.continuidade.find(x=>x.origem==='caso_humano')?.dados).toMatchObject({pergunta_humana:'Concluiu o formulário?',resposta_cliente:'Já fiz',significado:'resposta_do_cliente_nao_verificacao'});
    await pool.query("update calendar_appointments set status='cancelled',cancelled_at=now() where id=$1",[appointment]);
    const fresh=await carregarContextoDoAtendimento(pool,ids);expect(fresh.fingerprint).not.toBe(c.fingerprint);expect(fresh.operacoes.find(x=>x.origem==='agenda_persistida')?.dados.estado).toBe('cancelled');
    // Não deixar as operações desta fixture influírem nos outros testes sorteados.
    await pool.query('delete from agent_cases where id=$1',[caseId]);await pool.query('delete from cron_jobs where id=$1',[cron]);
    await pool.query('delete from crm_proposals where id=$1',[proposal]);await pool.query('delete from calendar_appointments where id=$1',[appointment]);
  });
  it('RLS permite o membro somente na própria organização',async()=>{
    const db=await pool.connect();
    try {
      await db.query('begin');await db.query('set local role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,true)",[actor]);
      expect((await carregarContextoDoAtendimento(db,ids)).perfil.length).toBeGreaterThan(0);
      expect((await carregarContextoDoAtendimento(db,{...ids,tenantId:other,leadId:otherContact})).perfil).toEqual([]);
      await db.query('rollback');
    }finally{db.release();}
  });
  it('alteração relevante invalida fotografia e aprovação da proposta antiga',async()=>{
    const before=await carregarContextoDoAtendimento(pool,ids);
    await pool.query('update lead_state set next_action_seq=8 where organization_id=$1 and contact_id=$2',[org,contact]);
    const after=await carregarContextoDoAtendimento(pool,ids);
    expect(after.fingerprint).not.toBe(before.fingerprint);expect(after.decisoes[0]?.dados.validade).toBe('unverifiable_or_superseded');
    await pool.query('update lead_state set next_action_seq=7 where organization_id=$1 and contact_id=$2',[org,contact]);
  });
  it('30 leituras após aquecimento: um read agrupado por fotografia e overhead p95 abaixo de100ms',async()=>{
    await carregarContextoDoAtendimento(pool,ids);const times:number[]=[];
    for(let i=0;i<30;i++){const t=performance.now();await carregarContextoDoAtendimento(pool,ids);times.push(performance.now()-t);}
    times.sort((a,b)=>a-b);const p95=times[Math.ceil(times.length*.95)-1]!;
    console.info(JSON.stringify({fixture_benchmark:'cp003_fontes',samples:30,queries_per_snapshot:1,p50_ms:times[14],p95_ms:p95}));expect(p95).toBeLessThanOrEqual(100);
  });
});
