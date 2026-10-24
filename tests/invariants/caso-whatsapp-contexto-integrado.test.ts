import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { carregarContextoDeDecisaoHumana, resolverEventoDoJob } from "@/lib/agent-engine/agent/contexto-de-decisao-humana";
import { lerComunicacaoDoCaso } from "@/lib/escalacao/comunicacao-do-caso";
import type { JobRow } from "@/lib/agent-engine/queue/queue";
import { carregarContextoDoAtendimento } from "@/lib/agent-engine/agent/contexto-do-atendimento";
import { sendTurnMessage } from "@/lib/agent-engine/edge/crm/send-message";
import type { CrmEdgeConfig } from "@/lib/agent-engine/edge/crm/mcp-client";
import { claimOfJob } from "@/lib/agent-engine/queue/claim";
import type { sendMessageHandler } from "@/app/api/v1/messages/_handler";
const send=vi.hoisted(()=>vi.fn<typeof sendMessageHandler>());
vi.mock("@/app/api/v1/messages/_handler",()=>({sendMessageHandler:send}));

if (!process.env.TEST_DB_CONTAINER) throw new Error("rode via pnpm test:db");
const pool = new pg.Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`, max: 3 });
const org=randomUUID(), other=randomUUID(), contact=randomUUID(), session=randomUUID(), conv=randomUUID();
const phone="+5511990000723";
let caseId:string, requestId:string;
beforeAll(async()=>{
  for(const id of [org,other])await pool.query("insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Prova','Prova')",[id]);
  await pool.query("insert into contacts(id,organization_id,name,phone_number) values($1,$2,'Prova','+5511990000724')",[contact,org]);
  await pool.query("insert into channel_sessions(id,organization_id,waha_session_name,status,webhook_secret_encrypted) values($1::uuid,$2,$1::text,'WORKING','\\x00'::bytea)",[session,org]);
  await pool.query("insert into conversations(id,organization_id,contact_id,channel_session_id,status) values($1,$2,$3,$4,'ai_handling')",[conv,org,contact,session]);
  await pool.query("insert into config_aviso_de_caso(organization_id,channel_session_id,telefone_destino,ligado,resposta_whatsapp_habilitada) values($1,$2,$3,true,true)",[org,session,phone]);
});
beforeEach(async()=>{
  send.mockReset();
  await pool.query("delete from job_queue where organization_id=$1",[org]);
  await pool.query("delete from agent_cases where organization_id=$1",[org]);
  await pool.query("delete from messages where organization_id=$1",[org]);
  await pool.query("update conversations set status='ai_handling',service_revision=1,current_demanda_id=null where id=$1",[conv]);
  await pool.query("update config_aviso_de_caso set ligado=true,resposta_whatsapp_habilitada=true,channel_session_id=$2,updated_at=clock_timestamp() where organization_id=$1",[org,session]);
  requestId=randomUUID();caseId=randomUUID();
  await pool.query("insert into messages(id,organization_id,conversation_id,channel_session_id,contact_id,direction,type,body,status) values($1,$2,$3,$4,$5,'inbound','text','A equipe pode confirmar a condição de Ana?','received')",[requestId,org,conv,session,contact]);
  await pool.query("insert into agent_cases(id,organization_id,conversation_id,title,summary,blocker,context_snapshot) values($1,$2,$3,'Condição','Pedido de Ana','Conferir com equipe',$4)",[caseId,org,conv,{request_message_id:requestId}]);
  await pool.query("insert into entregas_de_aviso_de_caso(organization_id,case_id,destino,channel_session_id,status,enviado_em) values($1,$2,$3,$4,'enviado',now())",[org,caseId,phone,session]);
});
afterAll(()=>pool.end());
async function reply(action="resolved",key=randomUUID()):Promise<{result:string;job:JobRow}> {
  const db=await pool.connect();
  try{
    await db.query("begin");await db.query("set local role service_role");
    await db.query("select set_config('request.jwt.claims','{\"role\":\"service_role\"}',true)");
    await db.query("select set_config('request.jwt.claim.role','service_role',true)");
    const result=await db.query("select fn_responder_caso_por_whatsapp($1,$2,$3,$4,$5,$6,$7) result",[org,caseId,session,[phone],action,'A equipe confirmou a condição de Ana.',key]);
    await db.query("commit");
    const jobs=await pool.query<JobRow>("select * from job_queue where organization_id=$1 and payload->>'case_id'=$2 order by created_at desc limit 1",[org,caseId]);
    return {result:result.rows[0].result,job:jobs.rows[0]!};
  }catch(e){await db.query("rollback");throw e;}finally{db.release();}
}
describe("resposta WhatsApp nativa integrada ao contexto humano privado",()=>{
  it("a resposta aceita tem evento canônico verificável sem inventar usuário do CRM",async()=>{
    const {result,job}=await reply();expect(result).toBe("accepted");
    const binding=await resolverEventoDoJob(pool,job);
    expect(binding).not.toBeNull();
    const event=await pool.query("select actor_user_id,metadata from agent_case_events where id=$1",[binding!.eventId]);
    expect(event.rows[0].actor_user_id).toBeNull();
    expect(event.rows[0].metadata.source).toBe("whatsapp");
    expect(job.payload.human_event_id).toBe(binding!.eventId);
    const context=await carregarContextoDeDecisaoHumana(pool,{tenantId:org,leadId:contact,conversationId:conv});
    expect(context.decisions[0]).toMatchObject({eligible:true,jobId:job.id,requestId,provenance:"authorized_internal_whatsapp"});
    const communication=await lerComunicacaoDoCaso(pool,org,caseId);
    expect(communication[0]).toMatchObject({event_id:binding!.eventId,job_id:job.id,state:"queued"});
    const shared=await carregarContextoDoAtendimento(pool,{tenantId:org,leadId:contact,conversationId:conv,jobId:job.id});
    expect(shared.pedido).toMatchObject({estado:"present",tipoTurno:"case_reply_turn",mensagem:{id:requestId,text:"A equipe pode confirmar a condição de Ana?"}});
  });
  it("pergunta humana também retoma o job e conserva o pedido canônico, sem virar confirmação",async()=>{
    const {job}=await reply("need_lead_info");
    expect(await resolverEventoDoJob(pool,job)).not.toBeNull();
    const context=await carregarContextoDeDecisaoHumana(pool,{tenantId:org,leadId:contact,conversationId:conv});
    expect(context.decisions[0]).toMatchObject({eligible:false,action:"need_lead_info",provenance:"authorized_internal_whatsapp"});
    const shared=await carregarContextoDoAtendimento(pool,{tenantId:org,leadId:contact,conversationId:conv,jobId:job.id});
    expect(shared.pedido?.mensagem?.id).toBe(requestId);
    expect(shared.continuidade.some(f=>JSON.stringify(f.dados).includes("A equipe confirmou a condição de Ana."))).toBe(true);
  });
  it("reentrega do webhook conserva um único evento e job canônicos",async()=>{
    const key=randomUUID();const first=await reply("resolved",key);
    expect((await reply("resolved",key)).result).toBe("duplicate");
    expect((await pool.query("select id from job_queue where organization_id=$1 and kind='case_reply_turn'",[org])).rows.map(r=>r.id)).toEqual([first.job.id]);
    expect((await pool.query("select id from agent_case_events where organization_id=$1 and kind='human_replied'",[org])).rowCount).toBe(1);
  });
  it.each([
    ["opt-in revogado","update config_aviso_de_caso set resposta_whatsapp_habilitada=false,updated_at=clock_timestamp() where organization_id=$1"],
    ["aviso desligado","update config_aviso_de_caso set ligado=false,updated_at=clock_timestamp() where organization_id=$1"],
    ["recibo deixou de estar enviado","update entregas_de_aviso_de_caso set status='falhou' where organization_id=$1"],
    ["novo atendimento","update conversations set service_revision=service_revision+1 where organization_id=$1"],
    ["decisão revogada","update agent_case_events set metadata=jsonb_set(metadata,'{review_context_v1,revoked_at}',to_jsonb(now()::text)) where organization_id=$1 and kind='human_replied'"],
    ["decisão expirada","update agent_case_events set metadata=jsonb_set(metadata,'{review_context_v1,expires_at}',to_jsonb('2000-01-01T00:00:00.000Z'::text)) where organization_id=$1 and kind='human_replied'"],
    ["recibo inexistente","update agent_case_events set metadata=jsonb_set(metadata,'{review_context_v1,delivery_id}',to_jsonb(gen_random_uuid()::text)) where organization_id=$1 and kind='human_replied'"],
  ])("%s impede reentrada, elegibilidade e saída antes do ledger",async(_name,sql)=>{
    const {job}=await reply();
    const claimed=(await pool.query<JobRow>("update job_queue set status='running',locked_by='temas-proof',locked_at=clock_timestamp() where id=$1 returning *,locked_at::text as claim_acquired_at",[job.id])).rows[0]!;
    await pool.query(sql,[org]);
    expect(await resolverEventoDoJob(pool,claimed)).toBeNull();
    expect((await carregarContextoDeDecisaoHumana(pool,{tenantId:org,leadId:contact,conversationId:conv})).decisions.every(d=>!d.eligible)).toBe(true);
    expect((await lerComunicacaoDoCaso(pool,org,caseId))[0]?.state).toBe("cancelled_or_stale");
    await expect(sendTurnMessage(pool,{supabase:{} as CrmEdgeConfig["supabase"]},{tenantId:org,leadId:contact,conversationId:conv,jobId:job.id,jobClaim:claimOfJob(claimed),seq:1,body:"Confirmação de teste"})).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    expect((await pool.query("select id from send_ledger where job_id=$1",[job.id])).rowCount).toBe(0);
  });
  it("desligar e religar o opt-in não revalida a delegação antiga",async()=>{
    const {job}=await reply();
    await pool.query("update config_aviso_de_caso set resposta_whatsapp_habilitada=false,updated_at=clock_timestamp() where organization_id=$1",[org]);
    await pool.query("update config_aviso_de_caso set resposta_whatsapp_habilitada=true,updated_at=clock_timestamp() where organization_id=$1",[org]);
    expect(await resolverEventoDoJob(pool,job)).toBeNull();
  });
  it("trocar organização, contato ou job no payload não transporta autoridade",async()=>{
    const {job}=await reply();
    for(const changed of [{...job,organization_id:other},{...job,contact_id:randomUUID()},{...job,id:randomUUID()}])
      expect(await resolverEventoDoJob(pool,changed)).toBeNull();
    expect((await pool.query("select fn_case_whatsapp_event_valid($1,$2,$3,$4) valid",[other,caseId,job.payload.human_event_id,job.id])).rows[0].valid).toBe(false);
  });
  it("anon/authenticated não podem invocar o verificador delegado",async()=>{
    for(const role of ["anon","authenticated"]){
      const db=await pool.connect();
      try{
        await db.query("begin");await db.query(`set local role ${role}`);
        await expect(db.query("select fn_case_whatsapp_event_valid($1,$2,$3,$4)",[org,caseId,randomUUID(),randomUUID()])).rejects.toMatchObject({code:"42501"});
      }finally{await db.query("rollback");db.release();}
    }
  });
  it("o sink real usa o mesmo evento no ledger e não duplica o efeito ao repetir",async()=>{
    // Somente o transporte do canal é simulado. Fila, lease, gates e ledger usam Postgres real.
    const {job}=await reply();
    const claimed=(await pool.query<JobRow>("update job_queue set status='running',locked_by='temas-proof',locked_at=clock_timestamp() where id=$1 returning *,locked_at::text as claim_acquired_at",[job.id])).rows[0]!;
    send.mockImplementation(async(_supabase,ctx,body)=>{
      const inserted=await pool.query("insert into messages(id,organization_id,conversation_id,channel_session_id,contact_id,direction,type,body,status) values($1,$2,$3,$4,$5,'outbound','text',$6,'sent') returning *",[ctx.internalMessageId,org,conv,session,contact,body.body]);
      return inserted.rows[0];
    });
    const input={tenantId:org,leadId:contact,conversationId:conv,jobId:job.id,jobClaim:claimOfJob(claimed),seq:1,body:"Confirmação de teste"};
    expect((await sendTurnMessage(pool,{supabase:{} as CrmEdgeConfig["supabase"]},input)).kind).toBe("sent");
    expect((await sendTurnMessage(pool,{supabase:{} as CrmEdgeConfig["supabase"]},input)).kind).toBe("already_sent");
    expect(send).toHaveBeenCalledTimes(1);
    expect((await pool.query("select human_event_id,status from send_ledger where job_id=$1",[job.id])).rows).toEqual([{human_event_id:job.payload.human_event_id,status:"accepted"}]);
  });
});
