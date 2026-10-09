/** Baseline nativo + catch de disposição usado pelo worker, sem modelo ou canal. */
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { withServiceJob, guardServiceEffect, requireCurrentAutonomousTurn } from "@/lib/atendimento/fronteira-server";
import { StaleServiceBoundaryError } from "@/lib/atendimento/fronteira";
import { disporJobAposFalha } from "@/workers/agent-worker/dispor-job-apos-falha";
import type { JobRow } from "@/lib/agent-engine/queue/queue";
import { sql } from "./psql-transporte";
const ORG = "06150001-0000-4000-8000-000000000001";
const CONTACT = "06150001-0000-4000-8000-000000000002";
const CONVERSATION = "06150001-0000-4000-8000-000000000003";
const OWNER = "06150001-0000-4000-8000-000000000004";
const SESSION = "06150001-0000-4000-8000-000000000005";
const OTHER = "06150001-0000-4000-8000-000000000006";
const pool = new pg.Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`, max: 3 });
afterAll(() => pool.end());
beforeAll(() => sql(`
 insert into auth.users(id,email) values('${OWNER}','revogacao@invariant.test');
 insert into organizations(id,slug,legal_name,display_name) values('${ORG}','revogacao-0615','Fictício','Fictício'),('${OTHER}','revogacao-outra-0615','Outra','Outra');
 insert into user_organizations(user_id,organization_id,role,accepted_at) values('${OWNER}','${ORG}','agent',now());
 insert into contacts(id,organization_id,display_name) values('${CONTACT}','${ORG}','Cliente fictício');
 insert into channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted) values('${SESSION}','${ORG}','revogacao-0615','\\x00'::bytea);
 insert into conversations(id,organization_id,contact_id,channel_session_id,status) values('${CONVERSATION}','${ORG}','${CONTACT}','${SESSION}','open');
`));
beforeEach(() => sql(`delete from followup_enrollments where organization_id='${ORG}'; delete from job_queue where organization_id='${ORG}'; update conversations set assigned_to_user_id=null,assignee_kind=null,bot_silenced_until=null,status='open' where id='${CONVERSATION}';`));
async function job() {
  await pool.query(`insert into job_queue(organization_id,contact_id,kind,status,locked_by,locked_at,payload)
    select organization_id,contact_id,'followup_turn','running','worker-canonico',clock_timestamp(),jsonb_build_object('service_boundary',jsonb_build_object('organization_id',organization_id,'contact_id',contact_id,'conversation_id',id,'service_revision',service_revision,'demanda_id',null,'demanda_revision',null)) from conversations where id=$1`, [CONVERSATION]);
  return (await pool.query<JobRow>("select *,locked_at::text as claim_acquired_at from job_queue where organization_id=$1 and status='running'", [ORG])).rows[0]!;
}
async function revoked(j: JobRow, org = ORG) {
  return (await pool.query("select fn_autonomous_turn_revoked($1,$2) as value", [org, j.id])).rows[0]!.value;
}
async function enrollment(j: JobRow, status = "active") {
  const version=(await pool.query("insert into followup_flow_versions(organization_id,graph) values($1,'{}') returning id",[ORG])).rows[0]!.id;
  const pointer=(await pool.query("insert into followup_flow_pointers(organization_id,name,handoff_policy,active_version_id) values($1,$2,'pause',$3) returning id",[ORG,`canônico-${j.id}`,version])).rows[0]!.id;
  const id=(await pool.query("insert into followup_enrollments(organization_id,pointer_id,version_id,contact_id,conversation_id,current_node_id,status) values($1,$2,$3,$4,$5,'enviar',$6) returning id",[ORG,pointer,version,CONTACT,CONVERSATION,status])).rows[0]!.id;
  // A origem de um job é imutável. O fixture nasce completo, sem UPDATE de origem.
  await pool.query("delete from job_queue where id=$1",[j.id]);
  await pool.query("insert into job_queue(id,organization_id,contact_id,kind,status,locked_by,locked_at,payload) values($1,$2,$3,'followup_turn','running',$4,$5,$6::jsonb)",[j.id,ORG,CONTACT,j.locked_by,j.claim_acquired_at,JSON.stringify({...j.payload,purpose:"send_message",followup_enrollment_id:id,node_id:"enviar",source_step_key:j.id})]);
  return id;
}
async function assign(release = false) {
  await pool.query("select fn_conversation_assign($1,$2,$3,'claim',null,false)", [ORG, CONVERSATION, OWNER]);
  if (release) await pool.query("select fn_conversation_assign($1,$2,null,'release',null,false)", [ORG, CONVERSATION]);
}
it("o fato canônico exige organização, job, conversa, tipo, entidade e estado concluído", async () => {
  const j = await job();
  for (const [org, conversation, eventType, entityKind, status] of [
    [OTHER, CONVERSATION, 'conversation.autonomous_turn_revoked', 'job', 'done'],
    [ORG, OTHER, 'conversation.autonomous_turn_revoked', 'job', 'done'],
    [ORG, CONVERSATION, 'conversation.autonomous_turn_revoked', 'job', 'pending'],
    [ORG, CONVERSATION, 'conversation.autonomous_turn_revoked', 'conversation', 'done'],
    [ORG, CONVERSATION, 'conversation.other', 'job', 'done'],
  ]) {
    await pool.query("insert into event_log(organization_id,event_type,entity_kind,entity_id,payload,status) values($1,$2,$3,$4,jsonb_build_object('conversation_id',$5::text),$6)", [org,eventType,entityKind,j.id,conversation,status]);
    expect(await revoked(j)).toBe(false);
    await expect(requireCurrentAutonomousTurn(pool,j)).resolves.toBeUndefined();
    expect((await pool.query("select fn_followup_claim_current($1,$2,$3,$4) value",[ORG,j.id,j.locked_by,j.claim_acquired_at])).rows[0]!.value).toBe(true);
  }
  await assign(true);
  expect(await revoked(j)).toBe(true);
  expect(await revoked(j, OTHER)).toBe(false);
});
it.each(["anon", "authenticated"])("%s não consulta a autoridade privada", async role => {
  const j = await job();
  const tx = await pool.connect();
  try {
    await tx.query("begin");
    await tx.query(`set local role ${role}`);
    await expect(tx.query("select fn_autonomous_turn_revoked($1,$2)", [ORG,j.id])).rejects.toMatchObject({ code: "42501" });
  } finally { await tx.query("rollback"); tx.release(); }
});
it("service_role consulta o predicado, sem ampliar leitura pública", async () => {
  const j = await job();
  await assign();
  const tx = await pool.connect();
  try {
    await tx.query("begin"); await tx.query("set local role service_role");
    expect((await tx.query("select fn_autonomous_turn_revoked($1,$2) value", [ORG,j.id])).rows[0]!.value).toBe(true);
  } finally { await tx.query("rollback"); tx.release(); }
});
it.each([false,true])("tomada durante withServiceJob, devolver=%s, atravessa catch real e não reenfileira", async release => {
  const j = await job(); const log = {warn:vi.fn()};
  let effects = 0; let caught: unknown;
  try {
    await withServiceJob(pool,j,async () => { await assign(release); await guardServiceEffect(); effects++; });
  } catch(error) { caught=error; await disporJobAposFalha(pool,j,"worker-canonico",error,error instanceof StaleServiceBoundaryError,log); }
  expect(caught).toBeInstanceOf(StaleServiceBoundaryError);
  expect(effects).toBe(0);
  expect((await pool.query("select status,locked_at,locked_by,last_error from job_queue where id=$1",[j.id])).rows[0]).toEqual({status:"failed",locked_at:null,locked_by:null,last_error:"service_boundary_stale"});
  expect(log.warn).not.toHaveBeenCalled();
});
it.each(["paused_handoff", "cancelled"])("catch do worker preserva %s e grava só a trilha permitida", async status => {
  const j=await job(); const id=await enrollment(j,status); await assign(true);
  const log={warn:vi.fn()};
  await disporJobAposFalha(pool,j,"worker-canonico",new StaleServiceBoundaryError(),true,log);
  expect((await pool.query("select status from followup_enrollments where id=$1",[id])).rows[0]!.status).toBe(status);
  const events=(await pool.query("select payload from followup_enrollment_events where enrollment_id=$1 and event_type='turn_discarded'",[id])).rows;
  expect(events).toEqual(status === "cancelled" ? [] : [{payload:{job_id:j.id,motivo:"conversation_command_taken"}}]);
  expect((await pool.query("select status from job_queue where id=$1",[j.id])).rows[0]!.status).toBe("failed");
});
it.each([OTHER, CONVERSATION])("descarte não aceita marcador de outra conversa/organização (%s)", async conversation => {
  const j=await job(); const id=await enrollment(j);
  await pool.query("insert into event_log(organization_id,event_type,entity_kind,entity_id,payload,status) values($1,'conversation.autonomous_turn_revoked','job',$2,jsonb_build_object('conversation_id',$3::text),'done')",[conversation === CONVERSATION ? OTHER : ORG,j.id,conversation]);
  expect(await revoked(j)).toBe(false);
  await disporJobAposFalha(pool,j,"worker-canonico",new StaleServiceBoundaryError(),true,{warn:vi.fn()});
  expect((await pool.query("select count(*)::int n from followup_enrollment_events where enrollment_id=$1",[id])).rows[0]!.n).toBe(0);
});
it("lease trocado pelo reaper produz aviso estruturado e não altera nem inventa descarte do ciclo novo", async () => {
  const j = await job(); await assign(true);
  await pool.query("update job_queue set locked_by='outro-worker',locked_at=clock_timestamp() where id=$1",[j.id]);
  const before=(await pool.query("select status,locked_by,locked_at::text from job_queue where id=$1",[j.id])).rows[0];
  const log={warn:vi.fn()};
  await disporJobAposFalha(pool,j,"worker-canonico",new StaleServiceBoundaryError(),true,log);
  expect(log.warn).toHaveBeenCalledExactlyOnceWith("followup_stale_discard_lease_changed",{job_id:j.id,organization_id:ORG,kind:"followup_turn"});
  expect((await pool.query("select status,locked_by,locked_at::text from job_queue where id=$1",[j.id])).rows[0]).toEqual(before);
  expect((await pool.query("select count(*)::int n from followup_enrollment_events where payload->>'job_id'=$1",[j.id])).rows[0]!.n).toBe(0);
  await expect(requireCurrentAutonomousTurn(pool,j)).rejects.toThrow("service_boundary_stale");
});
it("forward-fix reaplicável sobre funções da 0594 já instalada", async () => {
  const j = await job(); await assign(true);
  const old=fs.readFileSync(path.resolve("supabase/migrations/20261008001200_0594_assumir_interrompe_turno_autonomo.sql"),"utf8");
  const forward=fs.readFileSync(path.resolve("supabase/migrations/20261008235500_0615_revogacao_autonoma_canonica.sql"),"utf8");
  const tx=await pool.connect();
  try {
    await tx.query("begin");
    await tx.query(old.slice(old.indexOf('-- A mesma revogação'),old.indexOf('-- Reserva a autoridade nova')));
    await tx.query(forward); await tx.query(forward);
    expect((await tx.query("select fn_followup_claim_current($1,$2,$3,$4) as current",[ORG,j.id,j.locked_by,j.claim_acquired_at])).rows[0]!.current).toBe(false);
    expect((await tx.query("select fn_autonomous_turn_revoked($1,$2) as revoked",[ORG,j.id])).rows[0]!.revoked).toBe(true);
  } finally { await tx.query("rollback"); tx.release(); }
});
