/**
 * Fundação 9020 em PostgreSQL real. Não usa dublê de autorização/SQL.
 * A suíte não prova a integração futura do #3525 nem entrega WhatsApp.
 * As tentativas negativas rodam com ROLLBACK, inclusive se a base as permitir.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { claimJobs, completeJob } from "@/lib/agent-engine/queue/queue";
import { tickCron } from "@/lib/agent-engine/cron/scheduler";
import { criarOrigemDeFollowup } from "./followup-service-origin";

const connectionString = `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`;
const pool = new pg.Pool({ connectionString, max: 2 });
const workerRole = `fila9020_${randomUUID().replaceAll("-", "")}`;
// Papel SQL real, com os grants próprios da receita self-host. Não é JWT de sessão.
const workerPool = new pg.Pool({ connectionString, max: 1, options: `-c role=${workerRole}` });
const migration = readFileSync(join(process.cwd(), "supabase/migrations/20261027005100_9020_propriedade_da_fila_interna.sql"), "utf8");
const log = { info: () => {}, warn: () => {}, error: () => {} };
const roles = ["viewer", "agent", "manager", "admin"] as const;
const tenants: Tenant[] = [];
type Tenant = { org: string; contact: string; conversation: string; channel: string; job: string; users: Record<typeof roles[number], string> };

async function asRole(role: string, user: string | null, statement: string, values: unknown[] = [], commit = false) {
  if (!/^[a-z0-9_]+$/.test(role)) throw Error("papel de fixture inválido");
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local lock_timeout='1s'; set local statement_timeout='5s'");
    await client.query(`set local role "${role}"`);
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role, ...(user ? { sub: user, aal: "aal1" } : {}) })]);
    const result = await client.query(statement, values);
    await client.query(commit ? "commit" : "rollback");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally { client.release(); }
}

async function createTenant(): Promise<Tenant> {
  const org = randomUUID(), contact = randomUUID(), job = randomUUID();
  const users = Object.fromEntries(roles.map(role => [role, randomUUID()])) as Tenant["users"];
  await pool.query("insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Fila sintética','Fila sintética')", [org]);
  for (const role of roles) {
    await pool.query("insert into auth.users(id,email) values($1,$2)", [users[role], `${users[role]}@invariant.test`]);
    await pool.query("insert into user_organizations(organization_id,user_id,role,accepted_at) values($1,$2,$3,now())", [org, users[role], role]);
  }
  await pool.query("insert into contacts(id,organization_id,name,display_name) values($1,$2,'Contato sintético','Contato sintético')", [contact, org]);
  const boundary = await criarOrigemDeFollowup(pool, org, contact);
  const channel = (await pool.query("select channel_session_id from conversations where id=$1", [boundary.conversation_id])).rows[0].channel_session_id as string;
  await pool.query("insert into job_queue(id,organization_id,kind,status,payload) values($1,$2,'watchdog','done',$3)", [job, org, { control: "preservar" }]);
  return { org, contact, conversation: boundary.conversation_id, channel, job, users };
}

beforeAll(async () => {
  tenants.push(await createTenant(), await createTenant());
  await pool.query(`create role "${workerRole}" bypassrls`);
  await pool.query(`grant usage on schema public to "${workerRole}";
    grant select,insert,update,delete on all tables in schema public to "${workerRole}";
    grant execute on all functions in schema public to "${workerRole}";
    grant usage,select on all sequences in schema public to "${workerRole}";
    revoke update,delete,truncate on table public.api_audit_log from "${workerRole}"`);
});
afterAll(async () => {
  await workerPool.end();
  // O setup canônico recria o banco por arquivo. Não remover jobs isoladamente:
  // os controles positivos criam drafts com FK legítima para approved_reply.
  // A role é global ao cluster, portanto seus grants são descartados aqui.
  try { await pool.query(`drop owned by "${workerRole}"; drop role "${workerRole}"`); }
  finally { await pool.end(); }
});

// Predicado CAS real de identidade/lease, medido aqui em ordem sequencial.
// A concorrência com LGPD exige também fn_service_lock ANTES do lock do job
// (fila-snapshot-e-lgpd-concorrencia). A fiação do runtime pertence ao #3525.
const freeze = `update public.job_queue j set catalog_presentation_snapshot=$5::jsonb
  where j.id=$1 and j.organization_id=$2 and j.kind='inbound_turn' and j.status='running'
    and j.locked_by=$3 and j.locked_at=$4::timestamptz and j.catalog_presentation_snapshot is null
    and exists(select 1 from public.contacts c where c.id=j.contact_id and c.organization_id=j.organization_id and not c.is_anonymized)
  returning j.id`;
// Fixture do contrato JSON; a fundação não autentica operação por conteúdo.
// O consumidor do #3525 precisará validar esses IDs contra a operação original real.
function snapshot(org: string) {
  const product = randomUUID();
  return { schema_version: 1, sends_already_counted: 0, ordered_product_codes: ["A"],
    plan: { items: [{ product_id: product, product_code: "A", product_name: "Produto A",
      messages: [{ kind: "text", purpose: "presentation", product_id: product, product_code: "A", text: "Texto sintético" }],
      physical_message_count: 1 }], physical_message_count: 1 },
    agent_operation: { organizationId: org, agentId: randomUUID(), versionId: randomUUID(), revision: "1" } };
}

async function running(t: Tenant) {
  const id = randomUUID(), contact = randomUUID();
  await pool.query("insert into contacts(id,organization_id,name,display_name) values($1,$2,'Contato da execução','Contato da execução')",[contact,t.org]);
  return (await pool.query(`insert into job_queue(id,organization_id,contact_id,kind,status,locked_by,locked_at,payload)
    values($1,$2,$3,'inbound_turn','running','worker-9020',clock_timestamp(),'{}') returning *,locked_at::text as acquired`, [id,t.org,contact])).rows[0];
}

// Estes casos rodam também na base 7f1, antes da migration: o RED deve ser uma
// escrita indevidamente aceita, nunca a ausência da coluna nova.
describe("sessão não escreve diretamente na fila", () => {
  it("controle: cada papel lê status próprio e zero do outro tenant", async () => {
    for (const [i,t] of tenants.entries()) for (const role of roles) {
      const own = await asRole("authenticated",t.users[role],"select status from job_queue where id=$1",[t.job]);
      expect(own.rows).toEqual([{ status: "done" }]);
      expect((await asRole("authenticated",t.users[role],"select id from job_queue where id=$1",[tenants[1-i]!.job])).rows).toEqual([]);
    }
  });
  it("INSERT, UPDATE e DELETE são recusados com 42501 para própria org e vizinha, inclusive admin", async () => {
    for (const t of tenants) for (const role of roles) for (const target of tenants) {
      for (const [statement,values] of [
        ["insert into job_queue(organization_id,kind,payload) values($1,'watchdog',$2)",[target.org,{ catalog_presentation_snapshot: { forged: true } }]],
        ["update job_queue set payload=$2 where id=$1",[target.job,{ changed: true }]],
        ["delete from job_queue where id=$1",[target.job]],
      ] as const) await expect(asRole("authenticated",t.users[role],statement,[...values])).rejects.toMatchObject({ code: "42501" });
    }
    for (const t of tenants) expect((await pool.query("select payload,status from job_queue where id=$1",[t.job])).rows).toEqual([{payload:{control:"preservar"},status:"done"}]);
  });
  it("anon não lê nem escreve; TRUNCATE não é concedido à sessão", async () => {
    await expect(asRole("anon",null,"select id from job_queue")).rejects.toMatchObject({code:"42501"});
    await expect(asRole("anon",null,"delete from job_queue where id=$1",[tenants[0]!.job])).rejects.toMatchObject({code:"42501"});
    await expect(asRole("authenticated",tenants[0]!.users.admin,"truncate public.job_queue cascade")).rejects.toMatchObject({code:"42501"});
  });
});

describe("estado novo, enqueue e lease", () => {
  it("ACL não mantém mutação/controle em PUBLIC, anon e authenticated; funções de trigger não são RPC", async () => {
    for (const role of ["anon","authenticated"]) {
      const result=await pool.query(`select has_table_privilege($1,'public.job_queue','INSERT') as ins,
        has_table_privilege($1,'public.job_queue','UPDATE') as upd,
        has_table_privilege($1,'public.job_queue','DELETE') as del,
        has_table_privilege($1,'public.job_queue','TRUNCATE') as trunc,
        has_table_privilege($1,'public.job_queue','TRIGGER') as trg,
        has_table_privilege($1,'public.job_queue','REFERENCES') as ref`,[role]);
      expect(Object.values(result.rows[0])).toEqual([false,false,false,false,false,false]);
      for (const fn of ["fn_job_snapshot_interno_no_enqueue()","fn_limpar_snapshot_catalogo_ao_anonimizar()"])
        expect((await pool.query("select has_function_privilege($1,$2,'EXECUTE') as allowed",[role,`public.${fn}`])).rows[0].allowed).toBe(false);
    }
    expect((await pool.query(`select count(*)::int as n from pg_class c join pg_namespace n on n.oid=c.relnamespace
      cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
      where n.nspname='public' and c.relname='job_queue' and a.grantee=0`)).rows[0].n).toBe(0);
  });

  it("service e worker conservam INSERT comum, sem snapshot", async () => {
    for (const role of ["service_role",workerRole]) {
      const result=await asRole(role,null,"insert into job_queue(organization_id,kind,payload) values($1,'watchdog','{}') returning id",[tenants[0]!.org]);
      expect(result.rowCount).toBe(1);
    }
  });
  it("INSERT recusa chave reservada, inclusive null, e coluna preenchida para serviço/worker", async () => {
    for (const role of ["service_role",workerRole]) for (const value of [null,{},snapshot(tenants[0]!.org)]) {
      await expect(asRole(role,null,"insert into job_queue(organization_id,kind,payload) values($1,'watchdog',$2)",[tenants[0]!.org,{catalog_presentation_snapshot:value}])).rejects.toMatchObject({code:"42501",message:"job_snapshot_internal"});
      await expect(asRole(role,null,"insert into job_queue(organization_id,kind,catalog_presentation_snapshot) values($1,'watchdog',$2::jsonb)",[tenants[0]!.org,JSON.stringify(value)])).rejects.toMatchObject({code:"42501",message:"job_snapshot_internal"});
    }
  });
  it("UPDATE de worker requer identidade/lease corrente; repetição não sobrescreve estado", async () => {
    const t=tenants[0]!, job=await running(t), state=snapshot(t.org);
    const wrong=(await pool.query("select ($1::timestamptz+interval '1 microsecond')::text as value",[job.acquired])).rows[0].value;
    for (const [org,worker,lease] of [[tenants[1]!.org,"worker-9020",job.acquired],[t.org,"worker-errado",job.acquired],[t.org,"worker-9020",wrong]])
      expect((await asRole(workerRole,null,freeze,[job.id,org,worker,lease,JSON.stringify(state)])).rowCount).toBe(0);
    expect((await asRole(workerRole,null,freeze,[job.id,t.org,"worker-9020",job.acquired,JSON.stringify(state)],true)).rowCount).toBe(1);
    expect((await asRole(workerRole,null,freeze,[job.id,t.org,"worker-9020",job.acquired,JSON.stringify(snapshot(t.org))])).rowCount).toBe(0);
    expect((await pool.query("select catalog_presentation_snapshot from job_queue where id=$1",[job.id])).rows[0].catalog_presentation_snapshot).toEqual(state);
  });
  it("payload legado não é backfill; reaplicar conserva estado novo gravado pelo worker", async () => {
    const t=tenants[0]!, old=t.job, live=await running(t);
    // Simula dado anterior à 9020; o operador do teste é postgres, sem fabricar grant de sessão.
    await pool.query("update job_queue set payload=$2 where id=$1",[old,{catalog_presentation_snapshot:{forged:true}}]);
    const state=snapshot(t.org);
    await pool.query("update job_queue set catalog_presentation_snapshot=$2 where id=$1",[live.id,state]);
    await pool.query(migration); await pool.query(migration);
    const rows=(await pool.query("select id,payload,catalog_presentation_snapshot from job_queue where id=any($1::uuid[])",[[old,live.id]])).rows;
    expect(rows.find(r=>r.id===old)).toMatchObject({payload:{catalog_presentation_snapshot:{forged:true}},catalog_presentation_snapshot:null});
    expect(rows.find(r=>r.id===live.id)?.catalog_presentation_snapshot).toEqual(state);
  });
  it("claim/complete reais continuam funcionando pelo papel dedicado", async () => {
    const t=tenants[0]!, id=randomUUID();
    await workerPool.query("insert into job_queue(id,organization_id,kind,priority,run_after) values($1,$2,'watchdog',-32768,'1900-01-01')",[id,t.org]);
    const runningCount=Number((await pool.query("select count(*)::int as n from job_queue where status='running'")).rows[0].n);
    const jobs=await claimJobs(workerPool,{workerId:"claim-9020",batchSize:1,maxConcurrency:runningCount+1});
    expect(jobs.map(j=>j.id)).toEqual([id]);
    const acquired=jobs[0]!.claim_acquired_at!;
    await expect(completeJob(workerPool,id,"worker-errado",undefined,acquired)).rejects.toThrow("lease");
    await completeJob(workerPool,id,"claim-9020",undefined,acquired);
    expect((await pool.query("select status from job_queue where id=$1",[id])).rows[0].status).toBe("done");
  });
  it("scheduler real não promove snapshot copiado de cron ao enqueue", async () => {
    const t=tenants[0]!, id=randomUUID();
    await asRole("authenticated",t.users.manager,`insert into cron_jobs(id,organization_id,contact_id,kind,job_kind,payload,next_run_at,max_attempts)
      values($1,$2,$3,'at','inbound_turn',$4,'1800-01-01',1)`,[id,t.org,t.contact,{catalog_presentation_snapshot:snapshot(t.org)}],true);
    expect((await pool.query("select id from cron_jobs where enabled and next_run_at<=now() order by next_run_at,id limit 1")).rows[0].id).toBe(id);
    await tickCron(pool,{batchSize:1,staggerWindowMs:0,retryBaseMs:1},log);
    expect((await pool.query("select count(*)::int as n from job_queue where organization_id=$1 and payload ? 'catalog_presentation_snapshot' and kind='inbound_turn'",[t.org])).rows[0].n).toBe(0);
    expect((await pool.query("select last_error from cron_jobs where id=$1",[id])).rows[0].last_error).toContain("job_snapshot_internal");
  });
});


describe("comandos humanos e LGPD conservados", () => {
  it("fn_reply_action continua criando só a entrega aprovada pelo ator autorizado", async () => {
    const t=await createTenant(), agent=randomUUID(), version=randomUUID();
    await pool.query("update conversations set assigned_to_user_id=$1 where id=$2",[t.users.agent,t.conversation]);
    await pool.query("insert into ai_agents(id,organization_id,name,system_prompt,operation_mode) values($1,$2,'Assistente sintético','Ajude com fatos confirmados.','assisted')",[agent,t.org]);
    await pool.query("insert into ai_agent_versions(id,organization_id,agent_id,version_number,system_prompt,provider,model,channel_session_id,status) values($1,$2,$3,1,'Ajude com fatos confirmados.','anthropic','test-model',$4,'published')",[version,t.org,agent,t.channel]);
    await pool.query("update ai_agents set published_version_id=$1 where id=$2",[version,agent]);
    const draft=(await pool.query("select * from fn_reply_begin($1,$2,$3,$4,$5)",[t.org,t.conversation,agent,version,randomUUID()])).rows[0];
    await pool.query("update ai_reply_drafts set status='pending',original_body='Olá',edited_body='Olá' where id=$1",[draft.id]);
    const command="select fn_reply_action($1,$2,$3,'approve','Olá',null) as job";
    await expect(asRole("authenticated",t.users.viewer,command,[t.org,draft.id,String(draft.revision)])).rejects.toMatchObject({code:"42501"});
    const result=await asRole("authenticated",t.users.agent,command,[t.org,draft.id,String(draft.revision)],true);
    const job=result.rows[0].job;
    expect((await pool.query("select kind,catalog_presentation_snapshot from job_queue where id=$1",[job])).rows).toEqual([{kind:"approved_reply",catalog_presentation_snapshot:null}]);
    expect((await asRole("authenticated",t.users.agent,"select status from job_queue where id=$1",[job])).rows).toEqual([{status:"pending"}]);
  });
  it("fn_meet_action conserva entrega e requeue humano com a mesma identidade", async () => {
    const t=await createTenant(), appointment=randomUUID();
    await pool.query("insert into calendar_appointments(id,organization_id,contact_id,conversation_id,owner_user_id,title,starts_at,ends_at,status,location_kind) values($1,$2,$3,$4,$5,'Encontro sintético',now()+interval '4 days',now()+interval '4 days 1 hour','confirmed','in_person')",[appointment,t.org,t.contact,t.conversation,t.users.manager]);
    const row=async()=>(await pool.query("select * from calendar_appointments where id=$1",[appointment])).rows[0];
    const original=await row(), command="select fn_meet_action($1,$2,$3,$4,'deliver',$5) as changed";
    await expect(asRole("authenticated",t.users.agent,command,[t.org,appointment,String(original.revision),original.meeting_request_id,t.conversation])).rejects.toMatchObject({code:"42501"});
    await asRole("authenticated",t.users.manager,command,[t.org,appointment,String(original.revision),original.meeting_request_id,t.conversation],true);
    const active=await row(), job=active.meeting_delivery_job_id;
    expect(job).toEqual(expect.any(String));
    expect((await pool.query("select kind,catalog_presentation_snapshot from job_queue where id=$1",[job])).rows).toEqual([{kind:"transactional_delivery",catalog_presentation_snapshot:null}]);
    await pool.query("update job_queue set status='dead' where id=$1",[job]);
    await asRole("authenticated",t.users.manager,command,[t.org,appointment,String(active.revision),active.meeting_request_id,t.conversation],true);
    expect((await row()).meeting_delivery_job_id).toBe(job);
    expect((await asRole("authenticated",t.users.manager,"select status from job_queue where id=$1",[job])).rows).toEqual([{status:"pending"}]);
  });
  it("anonimização canônica limpa só a coluna do titular, sem mudar IDs/status/lease", async () => {
    const t=tenants[0]!, target=await running(t), neighbor=await running(tenants[1]!);
    await pool.query("update job_queue set catalog_presentation_snapshot=$2 where id=$1",[target.id,snapshot(t.org)]);
    const other=snapshot(tenants[1]!.org);
    await pool.query("update job_queue set catalog_presentation_snapshot=$2 where id=$1",[neighbor.id,other]);
    const before=(await pool.query("select id,status,locked_by,locked_at::text as acquired from job_queue where id=$1",[target.id])).rows[0];
    await asRole("service_role",null,"select fn_lgpd_cascade_redact_contact($1,$2,$3)",[t.org,target.contact_id,randomUUID()],true);
    const after=(await pool.query("select id,status,locked_by,locked_at::text as acquired,catalog_presentation_snapshot from job_queue where id=$1",[target.id])).rows[0];
    expect(after).toEqual({...before,catalog_presentation_snapshot:null});
    expect((await pool.query("select catalog_presentation_snapshot from job_queue where id=$1",[neighbor.id])).rows[0].catalog_presentation_snapshot).toEqual(other);
    expect((await asRole(workerRole,null,freeze,[target.id,t.org,"worker-9020",target.acquired,JSON.stringify(snapshot(t.org))])).rowCount).toBe(0);
  });
  it("DELETE do contato por sessão mantém CASCADE da fila, com o controle vizinho", async () => {
    const t=await createTenant(), job=randomUUID();
    await pool.query("insert into job_queue(id,organization_id,contact_id,kind,payload) values($1,$2,$3,'followup_turn','{}')",[job,t.org,t.contact]);
    await asRole("authenticated",t.users.manager,"select fn_apagar_contato_com_historico($1,$2)",[t.contact,t.org],true);
    expect((await pool.query("select id from contacts where id=$1",[t.contact])).rows).toEqual([]);
    expect((await pool.query("select id from job_queue where id=$1",[job])).rows).toEqual([]);
    expect((await pool.query("select id from job_queue where id=$1",[tenants[1]!.job])).rows).toHaveLength(1);
  });
});
