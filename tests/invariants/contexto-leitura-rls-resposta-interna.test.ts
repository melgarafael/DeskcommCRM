import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { carregarContextoDoAtendimento } from "@/lib/agent-engine/agent/contexto-do-atendimento";

if (!process.env.TEST_DB_CONTAINER) throw new Error("rode via pnpm test:db");
const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL ?? `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`, max: 2 });
const org=randomUUID(),other=randomUUID(),actor=randomUUID(),contact=randomUUID(),session=randomUUID(),conv=randomUUID(),request=randomUUID(),caseId=randomUUID();
const ids={tenantId:org,leadId:contact,conversationId:conv};
const phone="+5511990000801";
beforeAll(async()=>{
  for(const id of [org,other]) await pool.query("insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Fixture','Fixture')",[id]);
  await pool.query("insert into auth.users(id,email) values($1,$2)",[actor,actor+"@example.test"]);
  await pool.query("insert into user_organizations(user_id,organization_id,role) values($1,$2,'agent')",[actor,org]);
  await pool.query("insert into contacts(id,organization_id,name,phone_number) values($1,$2,'Fixture','+5511990000802')",[contact,org]);
  await pool.query("insert into channel_sessions(id,organization_id,waha_session_name,status,webhook_secret_encrypted) values($1::uuid,$2,$1::text,'WORKING','\\x00'::bytea)",[session,org]);
  await pool.query("insert into conversations(id,organization_id,contact_id,channel_session_id,status) values($1,$2,$3,$4,'ai_handling')",[conv,org,contact,session]);
  await pool.query("insert into config_aviso_de_caso(organization_id,channel_session_id,telefone_destino,ligado,resposta_whatsapp_habilitada) values($1,$2,$3,true,true)",[org,session,phone]);
  await pool.query("insert into messages(id,organization_id,conversation_id,channel_session_id,contact_id,direction,type,body,status) values($1,$2,$3,$4,$5,'inbound','text','Pedido fictício','received')",[request,org,conv,session,contact]);
  await pool.query("insert into agent_cases(id,organization_id,conversation_id,title,summary,blocker,context_snapshot) values($1,$2,$3,'Fixture','Pedido fictício','Equipe',$4)",[caseId,org,conv,{request_message_id:request}]);
  await pool.query("insert into entregas_de_aviso_de_caso(organization_id,case_id,destino,channel_session_id,status,enviado_em) values($1,$2,$3,$4,'enviado',now())",[org,caseId,phone,session]);
  const db=await pool.connect();try{
    await db.query("begin");await db.query("set local role service_role");
    await db.query("select set_config('request.jwt.claims','{\"role\":\"service_role\"}',true),set_config('request.jwt.claim.role','service_role',true)");
    const r=await db.query("select fn_responder_caso_por_whatsapp($1,$2,$3,$4,'need_lead_info','Qual é a condição de Ana?',$5) result",[org,caseId,session,[phone],randomUUID()]);
    expect(r.rows[0].result).toBe("accepted");await db.query("commit");
  }catch(e){await db.query("rollback");throw e;}finally{db.release();}
});
afterAll(async()=>{await pool.query("delete from organizations where id=any($1::uuid[])",[[org,other]]);await pool.query("delete from auth.users where id=$1",[actor]);await pool.end();});

describe("contexto sob RLS e validação interna restrita",()=>{
  it("membro lê seu contexto, recebe limite explícito e não ganha EXECUTE no validador",async()=>{
    const db=await pool.connect();try{
      await db.query("begin");await db.query("set local role authenticated");await db.query("select set_config('request.jwt.claim.sub',$1,true)",[actor]);
      expect((await db.query("select has_function_privilege(current_user,'public.fn_case_whatsapp_event_valid(uuid,uuid,uuid,text)','EXECUTE') allowed")).rows[0].allowed).toBe(false);
      const c=await carregarContextoDoAtendimento(db,ids);
      expect(c.continuidade.find(x=>x.origem==='caso_humano')?.dados).toMatchObject({pergunta_humana:null,limite_pergunta_humana:'validacao_da_resposta_interna_indisponivel_neste_papel'});
      expect((await carregarContextoDoAtendimento(db,{...ids,tenantId:other})).continuidade).toEqual([]);
      await expect(db.query("select fn_case_whatsapp_event_valid($1,$2,null,null)",[org,caseId])).rejects.toMatchObject({code:'42501'});
    }finally{await db.query("rollback");db.release();}
  });
  it("worker recebe a pergunta verificada pelo caminho nativo, sem omissão artificial",async()=>{
    const db=await pool.connect();try{
      await db.query("begin");await db.query("set local role service_role");
      const c=await carregarContextoDoAtendimento(db,ids);
      expect(c.continuidade.find(x=>x.origem==='caso_humano')?.dados.pergunta_humana).toBe('Qual é a condição de Ana?');
      expect(c.continuidade.find(x=>x.origem==='caso_humano')?.dados).not.toHaveProperty('limite_pergunta_humana');
    }finally{await db.query("rollback");db.release();}
  });
  it("trocar de papel na mesma conexão não reutiliza capacidade antiga nem abre outra organização",async()=>{
    const db=await pool.connect();try{
      await db.query("begin");await db.query("set local role service_role");
      expect((await carregarContextoDoAtendimento(db,ids)).continuidade.find(x=>x.origem==='caso_humano')?.dados.pergunta_humana).toBe('Qual é a condição de Ana?');
      await db.query("set local role authenticated");await db.query("select set_config('request.jwt.claim.sub',$1,true)",[actor]);
      expect((await carregarContextoDoAtendimento(db,ids)).continuidade.find(x=>x.origem==='caso_humano')?.dados.pergunta_humana).toBeNull();
      expect((await carregarContextoDoAtendimento(db,{...ids,tenantId:other})).perfil).toEqual([]);
    }finally{await db.query("rollback");db.release();}
  });
});
