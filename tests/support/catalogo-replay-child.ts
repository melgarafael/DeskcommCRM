/** Processo novo do teste: recebe só IDs da fixture, reivindica a fila real e
 * retoma com handler/BeforeSend/transporte de produção. Sem LLM nem .env.
 * A ponte Supabase é a já existente no harness, sobre o mesmo PG real.
 */
import pg from "pg";
import { claimJobs } from "@/lib/agent-engine/queue/queue";
import { createInboundTurnHandler, type InboundTurnDeps } from "@/lib/agent-engine/agent/inbound-turn";
import { withServiceJob } from "@/lib/atendimento/fronteira-server";
import { meetPgSupabase } from "./meet-pg-supabase";

const [org,jobId,mode]=process.argv.slice(2);
if(!org||!jobId||!mode)throw Error("fixture_args_missing");
const pool=new pg.Pool({connectionString:`postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,max:4});
let accepted=false,changed=false,agentId="";
async function changeBetweenEffects(){
  if(mode==="pause")await pool.query("update ai_agents set paused_at=clock_timestamp() where organization_id=$1 and id=$2",[org,agentId]);
  else if(mode==="revision")await pool.query("update ai_agents set config=config||'{\"catalog_fixture_revision\":true}'::jsonb where organization_id=$1 and id=$2",[org,agentId]);
  else if(mode==="mode")await pool.query("update ai_agents set operation_mode='assisted' where organization_id=$1 and id=$2",[org,agentId]);
  else if(mode==="lease")await pool.query("update job_queue set locked_by='outro-worker',locked_at=clock_timestamp() where organization_id=$1 and id=$2",[org,jobId]);
  else if(mode==="lgpd")await pool.query("select fn_lgpd_cascade_redact_contact($1,contact_id,null) from job_queue where organization_id=$1 and id=$2",[org,jobId]);
}
// Só o tempo é controlado: o resultado de TODA query continua sendo o PG real.
// A mudança vem DEPOIS do commit da primeira bolha, sem segurar contacts e
// esperar a LGPD no sentido inverso. Isto não é bypass de nenhuma guarda.
const executionPool=new Proxy(pool,{
  get(target,key){
    if(key==="query")return async(...args:unknown[])=>{
      const result=await Reflect.apply(target.query,target,args);
      if(typeof args[0]==="string"&&args[0].includes("update send_ledger set status=$3")&&Array.isArray(args[1])&&args[1][2]==="accepted")accepted=true;
      return result;
    };
    if(key==="connect")return async()=>{
      const client=await target.connect();
      return new Proxy(client,{get(c,k){
        if(k==="query")return async(...args:unknown[])=>{
          const result=await Reflect.apply(c.query,c,args);
          if(args[0]==="commit"&&accepted&&!changed&&mode!=="normal"){
            changed=true;await changeBetweenEffects();
          }
          return result;
        };
        const value=Reflect.get(c,k);return typeof value==="function"?value.bind(c):value;
      }});
    };
    const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;
  },
});
const bridge=meetPgSupabase(pool);
async function main(){
  const running=Number((await pool.query("select count(*)::int n from job_queue where status='running'")).rows[0].n);
  const claimed=await claimJobs(executionPool,{workerId:"catalog-restart",batchSize:1,maxConcurrency:running+1});
  const job=claimed.find(j=>j.id===jobId&&j.organization_id===org);
  if(!job)throw Error("fixture_job_not_claimed");
  // Usado só para a alteração concorrente da fixture, nunca para autorizar.
  agentId=(job.catalog_presentation_snapshot as {agent_operation:{agentId:string}}).agent_operation.agentId;
  const handler=createInboundTurnHandler({
    crmCfg:{supabase:bridge.client},llmCfg:{},
    knobs:{maxSendsPerTurn:10,queuedRetryDelayMs:1000,respostaObsoletaTetoMs:0},
    log:{info(){},warn(){},error(){},debug(){}},sleep:async()=>{},
  } as unknown as InboundTurnDeps);
  await withServiceJob(executionPool,job,()=>handler(job,executionPool,{workerId:"catalog-restart"}));
}
async function finish(){
  let failure:unknown;
  try{await main();}catch(error){failure=error;process.exitCode=2;}
  finally{
    await pool.end();
    process.stdout.write(JSON.stringify({ok:failure===undefined,changed,error:failure instanceof Error?failure.message:null,
      stack:failure instanceof Error?failure.stack?.split("\n").slice(0,6):undefined,
      dbErrorCodes:bridge.errors.map(e=>String((e as {code?:string}).code??"unknown"))})+"\n");
  }
}
void finish().catch(error=>{process.stderr.write(String(error));process.exitCode=3;});
