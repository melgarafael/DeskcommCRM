import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { carregarContextoDoAtendimento } from '@/lib/agent-engine/agent/contexto-do-atendimento';
import { carregarContextoDeDecisaoHumana } from '@/lib/agent-engine/agent/contexto-de-decisao-humana';
import { readCurrentServiceBoundary } from '@/lib/atendimento/fronteira-server';
if (!process.env.TEST_DB_CONTAINER) throw new Error('rode via pnpm test:db');
const pool=new pg.Pool({connectionString:`postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,max:3});
const org=randomUUID(),other=randomUUID(),contact=randomUUID(),conv=randomUUID(),session=randomUUID(),actor=randomUUID();
const first=randomUUID(),latest=randomUUID(),job=randomUUID(),secondJob=randomUUID(),caseId=randomUUID(),event=randomUUID(),replyJob=randomUUID();
const ids={tenantId:org,leadId:contact,conversationId:conv,jobId:job};
beforeAll(async()=>{
  for(const id of [org,other]) await pool.query(`insert into organizations(id,slug,legal_name,display_name,timezone) values($1::uuid,$1::uuid::text,'Fixture','Fixture','America/Sao_Paulo')`,[id]);
  await pool.query(`insert into contacts(id,organization_id,name,phone_number) values($1,$2,'Fixture','+5511999900450')`,[contact,org]);
  await pool.query(`insert into channel_sessions(id,organization_id,waha_session_name,status,webhook_secret_encrypted) values($1::uuid,$2,$1::uuid::text,'WORKING',$3)`,[session,org,Buffer.from([0])]);
  await pool.query(`insert into conversations(id,organization_id,contact_id,channel_session_id,status,is_group,service_started_at) values($1,$2,$3,$4,'ai_handling',false,'2026-10-09T00:00:00Z')`,[conv,org,contact,session]);
  await pool.query(`insert into auth.users(id,email) values($1,'cp004-pedido@example.test')`,[actor]);
  const boundary=await readCurrentServiceBoundary(pool,org,conv);
  for(const [id,text,at] of [[first,'Pedido de Ana para amanhã.','2026-10-09T12:00:00-03:00'],[latest,'Agora é para Bruno em outra data.','2026-10-10T12:00:00-03:00']])
    await pool.query(`insert into messages(id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,body,sent_at,service_revision,demanda_id) values($1,$2,$3,$4,$5,'text','inbound','received',$6,$7,$8,$9)`,[id,org,conv,session,contact,text,at,boundary!.service_revision,boundary!.demanda_id]);
  for(const [id,message] of [[job,first],[secondJob,latest]]) await pool.query(`insert into job_queue(id,organization_id,contact_id,kind,status,payload) values($1,$2,$3,'inbound_turn','pending',$4)`,[id,org,contact,{conversation_id:conv,inbound_message_id:message}]);
  await pool.query(`insert into agent_cases(id,organization_id,conversation_id,status,title,summary,blocker,context_snapshot) values($1,$2,$3,'resolved','Pedido Ana','Fixture','Equipe',$4)`,[caseId,org,conv,{request_message_id:first,service_boundary:boundary}]);
  await pool.query(`insert into agent_case_events(id,organization_id,case_id,kind,actor_kind,actor_user_id,human_action,body,metadata) values($1,$2,$3,'human_replied','human',$4,'resolved','Ana está confirmada para amanhã, sem ampliar condições.',$5)`,[event,org,caseId,actor,{review_context_v1:{versao:1,origem:'case_reply_authenticated',papel:'agent',job_id:replyJob}}]);
  await pool.query(`insert into job_queue(id,organization_id,contact_id,kind,status,payload) values($1,$2,$3,'case_reply_turn','pending',$4)`,[replyJob,org,contact,{conversation_id:conv,case_id:caseId,human_event_id:event}]);
  await pool.query(`insert into catalog_products(organization_id,codigo,nome,descricao,preco_cents,moeda,ativo,controla_estoque,quantidade) values($1,'ANUAL','Plano anual','Não inclui matrícula',20000,'BRL',true,false,0),($2,'ANUAL','OUTRO_TENANT','SEGREDO',100,'BRL',true,false,0)`,[org,other]);
});
afterAll(()=>pool.end());
describe('T08 pedido canônico e revisão real no banco',()=>{
  it('dois jobs usam suas mensagens distintas, nunca a última por aproximação',async()=>{
    const a=await carregarContextoDoAtendimento(pool,ids),b=await carregarContextoDoAtendimento(pool,{...ids,jobId:secondJob});
    expect(a.pedido!.mensagem).toMatchObject({id:first,text:'Pedido de Ana para amanhã.'});
    expect(b.pedido!.mensagem).toMatchObject({id:latest,text:'Agora é para Bruno em outra data.'});expect(a.fingerprint).not.toBe(b.fingerprint);
  });
  it('evento humano remete ao pedido original; leitura de decisões recebe exatamente esse pedido',async()=>{
    const c=await carregarContextoDoAtendimento(pool,{...ids,jobId:replyJob});
    expect(c.pedido).toMatchObject({tipoTurno:'case_reply_turn',estado:'present',mensagem:{id:first}});
    const h=await carregarContextoDeDecisaoHumana(pool,ids,{canonicalRequest:c.pedido!.mensagem});
    expect(h.currentRequest!.id).toBe(first);expect(h.currentRequest!.id).not.toBe(latest);expect(h.decisions[0]).toMatchObject({eligible:true,requestId:first});
  });
  it('troca de fronteira torna o pedido anterior indisponível',async()=>{
    await pool.query('update conversations set service_revision=service_revision+1 where id=$1',[conv]);
    const c=await carregarContextoDoAtendimento(pool,ids);expect(c.pedido!.estado).toBe('unavailable');expect(c.pedido!.mensagem).toBeNull();
    await pool.query('update conversations set service_revision=service_revision-1 where id=$1',[conv]);
  });
  it('pedido anterior sem demanda permanece na revisão em que a primeira demanda abriu',async()=>{
    const db=await pool.connect();
    try {
      await db.query('begin');const before=await readCurrentServiceBoundary(db,org,conv);expect(before!.demanda_id).toBeNull();
      // A função canônica só processa inbound ainda não carimbado.
      await db.query('update messages set service_revision=null,demanda_id=null,demanda_revision=null where id=$1',[first]);
      await db.query('select fn_service_inbound($1)',[first]);
      const current=await readCurrentServiceBoundary(db,org,conv);expect(current!.demanda_id).not.toBeNull();expect(current!.service_revision).toBe(before!.service_revision);
      // Mensagem legada anterior à primeira demanda, na mesma revisão.
      await db.query('update messages set demanda_id=null where id=$1',[first]);
      expect((await carregarContextoDoAtendimento(db,ids)).pedido!.mensagem!.id).toBe(first);
    } finally { await db.query('rollback');db.release(); }
  });
  it('releitura de produto é scoped, modifica fotografia e inclui indisponibilidade',async()=>{
    const p={...ids,productCodes:['ANUAL']};const a=await carregarContextoDoAtendimento(pool,p);
    expect(a.validacaoComercial!.produtos).toEqual([{codigo:'ANUAL',nome:'Plano anual',descricao:'Não inclui matrícula',preco:'R$\u00a0200,00',disponivel:true}]);
    expect(JSON.stringify(a)).not.toContain('OUTRO_TENANT');expect(a.fuso).toBe('America/Sao_Paulo');
    await pool.query("update catalog_products set preco_cents=30000,ativo=false where organization_id=$1 and codigo='ANUAL'",[org]);
    const b=await carregarContextoDoAtendimento(pool,p);expect(b.fingerprint).not.toBe(a.fingerprint);expect(b.validacaoComercial!.produtos[0]).toMatchObject({preco:'R$\u00a0300,00',disponivel:false});
  });
  it('estado terminal do job invalida sua fotografia, mesmo sem mudar o texto',async()=>{
    const a=await carregarContextoDoAtendimento(pool,ids);await pool.query("update job_queue set status='dead' where id=$1",[job]);
    expect((await carregarContextoDoAtendimento(pool,ids)).fingerprint).not.toBe(a.fingerprint);
  });
});
