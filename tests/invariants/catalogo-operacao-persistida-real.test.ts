/** Produtor/claim/handler/BeforeSend reais, PG real e receptor HTTP WAHA local.
 * Reusa a ponte PG do harness: não afirma testar HTTP PostgREST nem browser.
 * O replay acontece em PROCESSO NOVO, sem receber a operação por argumento.
 */
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { claimOfJob } from "@/lib/agent-engine/queue/claim";
import { rescheduleJob, type JobRow } from "@/lib/agent-engine/queue/queue";
import { CatalogPresentationLeaseLostError, resolveAndSnapshotCatalogPresentation } from "@/lib/catalogo/snapshot-de-apresentacao";
import { resumePersistedCatalogPresentation } from "@/lib/catalogo/retomada-de-apresentacao";
import { StaleServiceBoundaryError } from "@/lib/atendimento/fronteira";
import { criarOrigemDeFollowup } from "./followup-service-origin";
import { ehVistoAzul } from "../support/waha-visto-azul";

const pool=new pg.Pool({connectionString:`postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT??54329}/postgres`,max:4});
const ownedOrgs:string[]=[];
afterAll(()=>pool.end());
beforeEach(async()=>{
  // Só nossas fixtures deste arquivo; o harness já isola o banco por arquivo.
  for(const org of ownedOrgs)await pool.query("update job_queue set status='done',locked_by=null,locked_at=null where organization_id=$1",[org]);
});
async function fixture(){
  const org=randomUUID(),contact=randomUUID(),agent=randomUUID(),version=randomUUID(),user=randomUUID();ownedOrgs.push(org);
  await pool.query("insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Catálogo sintético','Catálogo sintético')",[org]);
  await pool.query("insert into auth.users(id,email) values($1,$2)",[user,`${user}@invariant.test`]);
  await pool.query("insert into user_organizations(organization_id,user_id,role,accepted_at) values($1,$2,'manager',now())",[org,user]);
  await pool.query("insert into contacts(id,organization_id,name,display_name,phone_number,source) values($1,$2,'Titular sintético','Titular sintético','+5531999998888','whatsapp')",[contact,org]);
  const boundary=await criarOrigemDeFollowup(pool,org,contact),conversation=boundary.conversation_id;
  const channel=(await pool.query("select channel_session_id from conversations where id=$1",[conversation])).rows[0].channel_session_id as string;
  await pool.query("update channel_sessions set metadata=metadata||'{\"ai_gate\":\"open\"}'::jsonb,status='WORKING' where id=$1",[channel]);
  await pool.query("insert into channel_knobs(organization_id,channel_session_id,throttle_ms,jitter_max_ms,window_start_hour,window_end_hour,resposta_start_hour,resposta_end_hour,timezone) values($1,$2,0,0,0,24,0,24,'UTC')",[org,channel]);
  await pool.query("insert into ai_agents(id,organization_id,name,system_prompt,operation_mode) values($1,$2,'Agente sintético','Responda só com fatos confirmados.','automatic')",[agent,org]);
  await pool.query("insert into ai_agent_versions(id,organization_id,agent_id,version_number,system_prompt,provider,model,channel_session_id,status) values($1,$2,$3,1,'Responda só com fatos confirmados.','anthropic','test-model',$4,'published')",[version,org,agent,channel]);
  await pool.query("update ai_agents set published_version_id=$1 where id=$2",[version,agent]);
  await pool.query("update conversations set active_ai_agent_id=$1 where id=$2",[agent,conversation]);
  const operation={organizationId:org,agentId:agent,versionId:version,revision:String((await pool.query("select operation_revision::text revision from ai_agents where id=$1",[agent])).rows[0].revision)};
  const products=[randomUUID(),randomUUID()];
  for(const[i,code]of["A","B"].entries()){
    await pool.query("insert into catalog_products(id,organization_id,codigo,nome,preco_cents) values($1,$2,$3,$4,100)",[products[i],org,code,i===0?"Item Azul":"Produto Verde"]);
    await pool.query("insert into catalog_product_presentations(organization_id,catalog_product_id,enabled,kind,text_content,use_catalog_photos,show_price) values($1,$2,true,'text',$3,false,false)",[org,products[i],i===0?"Suporte durante a instalação.":"Mantenha seu estoque organizado."]);
  }
  // O trigger do job deriva a origem desta mensagem persistida, nunca de um
  // UUID inventado nem da conversa atual após criar o trabalho.
  const inbound=randomUUID();
  await pool.query("insert into messages(id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,body) values($1,$2,$3,$4,$5,'text','inbound','Mensagem sintética do catálogo')",[inbound,org,conversation,channel,contact]);
  expect((await pool.query("select service_revision from messages where id=$1",[inbound])).rows[0].service_revision).not.toBeNull();
  const payload={conversation_id:conversation,contact_id:contact,channel_session_id:channel,inbound_message_id:inbound,crm_event_id:randomUUID()};
  const job=(await pool.query<JobRow>("insert into job_queue(organization_id,contact_id,kind,status,locked_by,locked_at,payload,attempts) values($1,$2,'inbound_turn','running','catalog-origin',clock_timestamp(),$3,1) returning *,locked_at::text claim_acquired_at",[org,contact,payload])).rows[0]!;
  expect(job.payload.service_boundary).toMatchObject({organization_id:org,contact_id:contact,conversation_id:conversation});
  return{org,contact,agent,version,user,channel,conversation,operation,job};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function input(f:Fixture){return{organizationId:f.org,contactId:f.contact,jobId:f.job.id,claim:claimOfJob(f.job)!,agentOperation:f.operation,sendsAlreadyCounted:0,maxSendsPerTurn:10,orderedProductCodes:["A","B"]};}
async function persisted(f:Fixture){return(await pool.query<JobRow>("select *,locked_at::text claim_acquired_at from job_queue where organization_id=$1 and id=$2",[f.org,f.job.id])).rows[0]!;}
async function directAnonymize(client:pg.PoolClient,f:Fixture){
  await client.query("begin;set local role authenticated;set local statement_timeout='5s'");
  await client.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:f.user,role:"authenticated"})]);
  return client.query("update contacts set is_anonymized=true,anonymized_at=clock_timestamp() where organization_id=$1 and id=$2 returning id",[f.org,f.contact]);
}

async function replayInNewProcess(f:Fixture,mode="normal"){
  const stored=await persisted(f);
  expect(await rescheduleJob(pool,stored.id,"catalog-origin",{acquiredAt:stored.claim_acquired_at!,delayMs:0,reason:"restart sintético"})).not.toBeNull();
  await pool.query("update job_queue set priority=-32768,run_after='1900-01-01' where id=$1",[stored.id]);
  const posts:Array<{path:string;text:unknown}>=[];
  let receiverError:unknown;
  const server=createServer(async(req,res)=>{
    if(ehVistoAzul(req.url)){res.end("{}");return;}
    if(req.method==="GET"){res.end(JSON.stringify({numberExists:true,chatId:"5531999998888@c.us"}));return;}
    try{
      const chunks:Buffer[]=[];for await(const part of req)chunks.push(Buffer.from(part));
      const body=JSON.parse(Buffer.concat(chunks).toString());
      posts.push({path:req.url??"",text:body.text});
      res.end(JSON.stringify({id:`catalog-${stored.id}-${posts.length}`}));
    }catch(error){receiverError=error;res.statusCode=500;res.end("{}");}
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const address=server.address();if(!address||typeof address==="string")throw Error("receiver_address");
  try{
    const child=await new Promise<{code:number;stdout:string;stderr:string}>(resolve=>{
      execFile(process.execPath,["node_modules/tsx/dist/cli.mjs","--tsconfig","tests/support/catalogo-replay-child.tsconfig.json","tests/support/catalogo-replay-child.ts",f.org,stored.id,mode],{
        cwd:process.cwd(),timeout:20_000,
        env:{PATH:process.env.PATH,NODE_ENV:"test",NODE_OPTIONS:"--max-old-space-size=1024",TEST_DB_PORT:process.env.TEST_DB_PORT??"54329",
          WAHA_API_BASE_URL:`http://127.0.0.1:${address.port}`,WAHA_API_KEY:"synthetic-receiver",
          NEXT_PUBLIC_SUPABASE_URL:"http://127.0.0.1:1",NEXT_PUBLIC_SUPABASE_ANON_KEY:"test-anon-key",
          SUPABASE_SERVICE_ROLE_KEY:"test-service-role-key-not-a-placeholder-1234567890-1234567890"},
      },(error,stdout,stderr)=>resolve({code:error?Number(error.code)||1:0,stdout,stderr}));
    });
    expect(receiverError).toBeUndefined();
    const last=child.stdout.trim().split("\n").at(-1);
    expect(last,child.stderr).toBeTruthy();
    const result=JSON.parse(last!) as{ok:boolean;changed:boolean;error:string|null;dbErrorCodes:string[]};
    return{posts,result,child};
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
}

describe("estado original de catálogo no banco real",()=>{
  it("produtor real ignora legado, preserva payload e persiste somente a operação allowlistada",async()=>{
    const f=await fixture(),legacy={...f.job.payload,catalog_presentation_snapshot:{forged:true}};
    await pool.query("update job_queue set payload=$2 where id=$1",[f.job.id,legacy]);
    const enriched={...f.operation,prompt:"não copiar",api_key:"sintética",contact_name:"não copiar"};
    const result=await resolveAndSnapshotCatalogPresentation(pool,{...input(f),agentOperation:enriched});
    expect(result).toMatchObject({ok:true,reused:false,snapshot:{agent_operation:f.operation}});
    const row=await persisted(f);
    expect(row.payload).toEqual(legacy);
    expect((row.catalog_presentation_snapshot as {agent_operation:unknown}).agent_operation).toEqual(f.operation);
    expect(await resolveAndSnapshotCatalogPresentation(pool,input(f))).toMatchObject({ok:true,reused:true});
  });
  it("microssegundo diferente no lease não congela estado",async()=>{
    const f=await fixture();
    const wrong=(await pool.query("select ($1::timestamptz+interval '1 microsecond')::text t",[f.job.claim_acquired_at])).rows[0].t;
    await expect(resolveAndSnapshotCatalogPresentation(pool,{...input(f),claim:{worker_id:"catalog-origin",acquired_at:wrong}})).rejects.toBeInstanceOf(CatalogPresentationLeaseLostError);
    expect((await persisted(f)).catalog_presentation_snapshot).toBeNull();
  });
  it("payloadlegado com colunaNULL não inicia o plano nem toca transporte",async()=>{
    const f=await fixture();
    await pool.query("update job_queue set payload=payload||'{\"catalog_presentation_snapshot\":{\"forged\":true}}'::jsonb where id=$1",[f.job.id]);
    const unexpected=()=>{throw Error("plano legado não deve tocar dependências de envio");};
    await expect(resumePersistedCatalogPresentation(pool,await persisted(f),{workerId:"catalog-origin"},{conversationId:f.conversation,channelSessionId:f.channel},{
      channel:{send:unexpected} as never,log:{} as never,maxSendsPerTurn:10,queuedRetryDelayMs:1000,respostaObsoletaTetoMs:0,
    })).resolves.toEqual({handled:false});
  });
  it("lease perdido depois da persistência bloqueia antes de mídia ou transporte",async()=>{
    const f=await fixture();await resolveAndSnapshotCatalogPresentation(pool,input(f));
    const old=await persisted(f);
    await pool.query("update job_queue set locked_by='outro-worker',locked_at=clock_timestamp() where id=$1",[old.id]);
    const unexpected=()=>{throw Error("lease perdido não deve alcançar envio");};
    await expect(resumePersistedCatalogPresentation(pool,old,{workerId:"catalog-origin"},{conversationId:f.conversation,channelSessionId:f.channel},{
      channel:{send:unexpected} as never,log:{} as never,maxSendsPerTurn:10,queuedRetryDelayMs:1000,respostaObsoletaTetoMs:0,
    })).rejects.toBeInstanceOf(StaleServiceBoundaryError);
  });
  it("novo processo reivindica, relê e entrega a operação original, sem input de operação",async()=>{
    const f=await fixture();await resolveAndSnapshotCatalogPresentation(pool,input(f));
    const r=await replayInNewProcess(f);
    expect(r.child.code,JSON.stringify(r.result)+"\n"+r.child.stderr).toBe(0);expect(r.result).toMatchObject({ok:true,changed:false,dbErrorCodes:[]});
    expect(r.posts).toHaveLength(2);expect(r.posts.every(p=>p.path==="/api/sendText")).toBe(true);
    expect((await pool.query("select seq,status from send_ledger where job_id=$1 order by seq",[f.job.id])).rows).toEqual([{seq:1,status:"accepted"},{seq:2,status:"accepted"}]);
    expect((await persisted(f)).catalog_presentation_snapshot).toMatchObject({agent_operation:f.operation});
  });
  it("revisão alterada antes do restart não reautoriza o plano pelo agente mais recente",async()=>{
    const f=await fixture();await resolveAndSnapshotCatalogPresentation(pool,input(f));
    await pool.query("update ai_agents set config=config||'{\"revision_before_restart\":true}'::jsonb where id=$1",[f.agent]);
    expect(String((await pool.query("select operation_revision::text revision from ai_agents where id=$1",[f.agent])).rows[0].revision)).not.toBe(f.operation.revision);
    const r=await replayInNewProcess(f);
    expect(r.child.code,JSON.stringify(r.result)).toBe(2);expect(r.result.error).toBe("service_boundary_stale");
    expect(r.posts).toHaveLength(0);expect(r.result.changed).toBe(false);
    expect((await persisted(f)).catalog_presentation_snapshot).toMatchObject({agent_operation:f.operation});
  });
  it.each(["pause","revision","mode","lease","lgpd"])("%s entre duas bolhas impede a segunda e qualquer fallback",async(mode)=>{
    const f=await fixture();await resolveAndSnapshotCatalogPresentation(pool,input(f));
    const r=await replayInNewProcess(f,mode);
    expect(r.result.changed,JSON.stringify(r.result)+"\n"+r.child.stderr).toBe(true);expect(r.posts).toHaveLength(1);
    expect(r.child.code).toBe(2);expect(r.result.ok).toBe(false);
    if(["revision","mode","lease"].includes(mode))expect(r.result.error).toBe("service_boundary_stale");
    if(mode==="pause")expect((await persisted(f)).status).toBe("pending");
    if(mode==="lgpd")expect((await persisted(f)).catalog_presentation_snapshot).toBeNull();
  });
});

describe("produtor real e anonimização concorrente",()=>{
  it("produtor toma mutex antes do job: UPDATE cru recusa40001, retry posterior limpa",async()=>{
    const f=await fixture();let release!:()=>void,started!:()=>void;
    const hold=new Promise<void>(r=>{release=r;}),observed=new Promise<void>(r=>{started=r;});
    const controlled=new Proxy(pool,{get(target,key){
      if(key==="connect")return async()=>{
        const client=await target.connect();return new Proxy(client,{get(c,k){
          if(k==="query")return async(text:string,values?:unknown[])=>{
            const result=await c.query(text,values);if(text.includes("fn_service_lock")){started();await hold;}return result;
          };
          const value=Reflect.get(c,k);return typeof value==="function"?value.bind(c):value;
        }});
      };
      const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;
    }});
    const pending=resolveAndSnapshotCatalogPresentation(controlled,input(f));const caught=pending.catch(()=>null);
    const direct=await pool.connect();
    try{
      await observed;
      await expect(directAnonymize(direct,f)).rejects.toMatchObject({code:"40001",message:"contact_redaction_busy"});
      await direct.query("rollback");release();expect(await pending).toMatchObject({ok:true});await caught;
      expect((await persisted(f)).catalog_presentation_snapshot).not.toBeNull();
      expect((await directAnonymize(direct,f)).rowCount).toBe(1);await direct.query("commit");
      expect((await persisted(f)).catalog_presentation_snapshot).toBeNull();
    }finally{release();await direct.query("rollback");direct.release();await caught;}
  });
  it("anonimização primeiro: produtor real espera e depois não grava",async()=>{
    const f=await fixture(),direct=await pool.connect();
    let pid=0;
    const controlled=new Proxy(pool,{get(target,key){
      if(key==="connect")return async()=>{const client=await target.connect();pid=Number((await client.query("select pg_backend_pid() p")).rows[0].p);return client;};
      const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;
    }});
    let pending:ReturnType<typeof resolveAndSnapshotCatalogPresentation>|undefined;
    try{
      await directAnonymize(direct,f);const holder=Number((await direct.query("select pg_backend_pid() p")).rows[0].p);
      pending=resolveAndSnapshotCatalogPresentation(controlled,input(f));const caught=pending.catch(()=>null);
      await expect.poll(async()=>pid>0&&(await pool.query("select wait_event,pg_blocking_pids(pid) blockers from pg_stat_activity where pid=$1",[pid])).rows.some(r=>r.wait_event==="advisory"&&r.blockers.includes(holder)),{timeout:5000,interval:10}).toBe(true);
      await direct.query("commit");await expect(pending).rejects.toBeInstanceOf(CatalogPresentationLeaseLostError);await caught;
      expect((await persisted(f)).catalog_presentation_snapshot).toBeNull();
    }finally{await direct.query("rollback");direct.release();await pending?.catch(()=>{});}
  });
});
