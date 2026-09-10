import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { createAdminClient } from "@/lib/supabase/admin";
import { runRoutingWorker } from "@/lib/routing/worker";
import { routingPgSupabase } from "../support/routing-pg-supabase";
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));
import { seedGov, GOV_ORG as org, GOV_AGENT_A as ana, GOV_AGENT_B as bruno, GOV_MANAGER as manager, GOV_ADMIN as admin, GOV_VIEWER as viewer, GOV_SESSION as channel, GOV_CONV_UNASSIGNED as conv, GOV_CONV_CLAIM as second } from "./gov-helpers";
const pool = new Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`, max: 5 });
const query = (text: string, args: unknown[] = []) => pool.query(text, args);
async function asUser(user: string, text: string, args: unknown[] = [], aal = "aal1") {
  const c = await pool.connect();
  try {
    await c.query("begin"); await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, aal })]);
    const result = await c.query(text, args); await c.query("commit"); return result;
  } catch (error) { await c.query("rollback"); throw error; } finally { c.release(); }
}
const policy = (users: string[], reset = false) => asUser(manager, "select fn_set_channel_routing($1,$2,$3,$4) result", [org, channel, users, reset]);
const claim = (conversation = conv, user = ana, expectedChannel = channel) => query("select fn_channel_routing_claim($1,$2,$3,$4,'{}') result", [org, conversation, expectedChannel, user]).then(r => r.rows[0].result);

beforeAll(() => seedGov());
afterAll(() => pool.end());
beforeEach(async () => {
  await query("update user_organizations set revoked_at=null,role='agent' where organization_id=$1 and user_id=any($2)", [org, [ana, bruno]]);
  await query("delete from channel_routing_policies where organization_id=$1", [org]);
  await query("update conversations set assigned_to_user_id=null,assignee_kind=null,status='open' where organization_id=$1", [org]);
  await query("insert into attendant_availability(organization_id,user_id,is_available,capacity,schedule) values($1,$2,true,1,'{}') on conflict(organization_id,user_id) do update set is_available=true,capacity=1,schedule='{}'", [org, ana]);
});

describe("roteamento instalado e transacional", () => {
  it("ausência de policy usa legado; CAS de replay conserva dono", async () => {
    expect(await claim()).toBe("assigned"); expect(await claim()).toBe("already_assigned");
    const r = await query("select assignee_kind,assigned_to_user_id,assigned_to_user_name,status from conversations where organization_id=$1 and id=$2", [org, conv]);
    expect(r.rows[0]).toMatchObject({ assignee_kind: "user", assigned_to_user_id: ana, status: "claimed" });
  });
  it("política vazia bloqueia e reset remove somente o marcador", async () => {
    await policy([]); expect(await claim()).toBe("candidate_not_allowed");
    await policy([], true); expect(await claim()).toBe("assigned");
  });
  it("revogação entre seleção e claim remove vínculo imediatamente", async () => {
    await policy([ana]); await query("update user_organizations set revoked_at=now() where organization_id=$1 and user_id=$2", [org, ana]);
    expect(await claim()).toBe("candidate_revoked");
    expect((await query("select count(*)::int n from channel_routing_responsibles where organization_id=$1", [org])).rows[0].n).toBe(0);
  });
  it("duas conversas concorrentes disputam uma única vaga global", async () => {
    expect((await Promise.all([claim(conv), claim(second)])).sort()).toEqual(["assigned", "capacity_changed"]);
  });
  it("alteração de jornada entre seleção e claim invalida o snapshot", async () => {
    await query("update attendant_availability set schedule='{\"timezone\":\"UTC\"}' where organization_id=$1 and user_id=$2", [org, ana]);
    expect(await claim()).toBe("capacity_changed");
  });
  it("canal divergente é terminal sem atribuir", async () => {
    expect(await claim(conv, ana, "00000000-0000-4000-8000-000000000000")).toBe("conversation_changed");
  });
  it("viewer não grava; usuário estranho não provoca substituição parcial", async () => {
    await expect(asUser(viewer,"select fn_set_channel_routing($1,$2,$3,false)",[org,channel,[ana]])).rejects.toThrow("routing_forbidden");
    await policy([ana]);
    await expect(policy(["00000000-0000-4000-8000-000000000000"])).rejects.toThrow("routing_invalid_members");
    expect(await claim()).toBe("assigned");
  });
  it("aviso único resolve na atribuição e evento ativo é deduplicado", async () => {
    await query("select fn_routing_unassigned_notice($1,$2,'no_eligible'),fn_request_channel_routing($1,$2)", [org, conv]);
    await query("select fn_routing_unassigned_notice($1,$2,'no_eligible'),fn_request_channel_routing($1,$2)", [org, conv]);
    const n = await query("select count(*)::int n from agent_inbox_items where organization_id=$1 and ref_id=$2 and kind='routing_unassigned'", [org, conv]);
    expect(n.rows[0].n).toBe(1); expect(await claim()).toBe("assigned");
    expect((await query("select status from agent_inbox_items where organization_id=$1 and ref_id=$2 and kind='routing_unassigned'",[org,conv])).rows[0].status).toBe("resolved");
  });
  it("RLS não revela políticas a não membro; RPC privada não é alcançável por authenticated", async () => {
    await policy([ana]);
    const outsider = "00000000-0000-4000-8000-000000000001";
    expect((await asUser(outsider,"select * from channel_routing_policies where organization_id=$1",[org])).rowCount).toBe(0);
    expect((await asUser(outsider,"select * from channel_routing_responsibles where organization_id=$1",[org])).rowCount).toBe(0);
    await expect(asUser(ana,"select fn_channel_routing_claim($1,$2,$3,$4,'{}')",[org,conv,channel,ana])).rejects.toThrow("permission denied");
  });
});

describe("reserva de conexão org-owned", () => {
  const key = "10000000-0000-4000-8000-000000000001";
  const reserve = (hash="a".repeat(64)) => asUser(admin,"select fn_reserve_channel_connection($1,$2,$3,'Teste',false) result",[org,key,hash]).then(r=>r.rows[0].result);
  beforeEach(()=>query("delete from channel_connection_requests where organization_id=$1",[org]));
  it("concorrência da mesma chave não cria duas identidades; payload distinto conflita", async () => {
    const first = await reserve(); expect(first.channel.organization_id).toBe(org);
    // WAHA 2026.7.2 rejeita a criação acima de 54 caracteres com HTTP 400.
    expect(first.channel.waha_session_name.length).toBeLessThanOrEqual(54);
    expect(first.channel.waha_session_name).toMatch(/^org_[0-9a-f]{8}_[0-9a-f]{32}$/);
    await expect(reserve()).rejects.toThrow("connection_in_progress");
    await expect(reserve("b".repeat(64))).rejects.toThrow("idempotency_conflict");
    await query("select fn_finish_channel_connection($1,$2,$3,'SCAN_QR_CODE')",[org,first.receipt_id,first.lease_token]);
    const replay = await reserve(); expect(replay.replay).toBe(true); expect(replay.channel.id).toBe(first.channel.id);
  });
  it("lease incorreta não publica sucesso; falha mantém identidade FAILED para reparo", async () => {
    const first = await reserve();
    await expect(query("select fn_finish_channel_connection($1,$2,$3,'WORKING')",[org,first.receipt_id,key])).rejects.toThrow("connection_lease_lost");
    await query("select fn_finish_channel_connection($1,$2,$3,'FAILED','connection_repair_required')",[org,first.receipt_id,first.lease_token]);
    const next = await reserve(); expect(next.channel.id).toBe(first.channel.id); expect(next.lease_token).not.toBe(first.lease_token);
  });
  it("retry antigo não toma o lease de outro recibo do mesmo onboarding", async () => {
    const firstKey = "40000000-0000-4000-8000-000000000001", nextKey = "40000000-0000-4000-8000-000000000002";
    const reserveOnboarding = (k: string) => asUser(admin,"select fn_reserve_channel_connection($1,$2,$3,null,true) result",[org,k,"d".repeat(64)]).then(r=>r.rows[0].result);
    const first = await reserveOnboarding(firstKey);
    await query("select fn_finish_channel_connection($1,$2,$3,'FAILED','repair')",[org,first.receipt_id,first.lease_token]);
    const next = await reserveOnboarding(nextKey); expect(next.channel.id).toBe(first.channel.id);
    await expect(reserveOnboarding(firstKey)).rejects.toThrow("connection_in_progress");
  });
  it("recibo privado não concede SELECT/UPDATE a membro", async () => {
    await reserve();
    await expect(asUser(admin,"select * from channel_connection_requests where organization_id=$1",[org])).rejects.toThrow("permission denied");
  });
});

describe("fronteiras de política e reserva", () => {
  it("dois tenants reais: leitura positiva local, negativa cruzada e FK composta", async () => {
    const otherOrg = "30000000-0000-4000-8000-000000000001", otherUser = "30000000-0000-4000-8000-000000000002";
    await query("insert into organizations(id,slug,legal_name,display_name) values($1,'routing-other','Outra','Outra') on conflict do nothing",[otherOrg]);
    await query("insert into auth.users(id,email) values($1,'routing-other@invariant.test') on conflict do nothing",[otherUser]);
    await query("insert into user_organizations(organization_id,user_id,role,accepted_at) values($1,$2,'admin',now()) on conflict do nothing",[otherOrg,otherUser]);
    await policy([ana]);
    expect((await asUser(manager,"select * from channel_routing_policies where organization_id=$1",[org])).rowCount).toBe(1);
    expect((await asUser(otherUser,"select * from channel_routing_policies where organization_id=$1",[org])).rowCount).toBe(0);
    expect((await asUser(otherUser,"select * from channel_routing_responsibles where organization_id=$1",[org])).rowCount).toBe(0);
    await expect(query("insert into channel_routing_policies(organization_id,channel_session_id) values($1,$2)",[otherOrg,channel])).rejects.toMatchObject({code:"23503"});
    await expect(asUser(otherUser,"select fn_set_channel_routing($1,$2,$3,false)",[org,channel,[otherUser]])).rejects.toThrow("routing_forbidden");
  });
  it("platform admin com fator cadastrado prova MFA nas duas RPCs humanas", async () => {
    const factor="30000000-0000-4000-8000-000000000003";
    await query("insert into platform_admins(user_id,granted_by,scope,mfa_required,reason) values($1,$1,'full',false,'Test')",[admin]);
    await query("insert into auth.mfa_factors(id,user_id,status,factor_type) values($1,$2,'verified','totp')",[factor,admin]);
    try {
      await expect(asUser(admin,"select fn_set_channel_routing($1,$2,$3,false)",[org,channel,[]])).rejects.toThrow("routing_mfa_required");
      await expect(asUser(admin,"select fn_reserve_channel_connection($1,$2,$3)",[org,factor,"c".repeat(64)])).rejects.toThrow("connection_mfa_required");
      expect((await asUser(admin,"select fn_set_channel_routing($1,$2,$3,false)",[org,channel,[]],"aal2")).rowCount).toBe(1);
      expect((await asUser(admin,"select fn_reserve_channel_connection($1,$2,$3)",[org,factor,"c".repeat(64)],"aal2")).rowCount).toBe(1);
    } finally { await query("delete from auth.mfa_factors where id=$1",[factor]);await query("delete from platform_admins where user_id=$1",[admin]); }
  });
});


describe("worker real contra PostgreSQL — ponte SQL, sem HTTP PostgREST", () => {
  it("timestamp do trigger permite persistir requeue/attempts/aviso; payload inválido fica terminal", async () => {
    await policy([]);
    await query("update organizations set settings=jsonb_set(settings,'{routing}','{\"mode\":\"round_robin\",\"max_retries\":1,\"backoff_seconds\":1}') where id=$1",[org]);
    await query("delete from event_log where organization_id=$1 and event_type='conversation.routing_requested'",[org]);
    await query("select fn_request_channel_routing($1,$2)",[org,conv]);
    await query("update event_log set attempts=1,next_attempt_at=null where organization_id=$1 and entity_id=$2 and event_type='conversation.routing_requested'",[org,conv]);
    const adapter=routingPgSupabase(pool);vi.mocked(createAdminClient).mockReturnValue(adapter.client as never);
    const now=new Date(); const result=await runRoutingWorker({now});
    expect(result.outcomes.requeued_no_eligible).toBe(1);expect(adapter.errors).toEqual([]);
    const pending=(await query("select status,attempts,next_attempt_at from event_log where organization_id=$1 and entity_id=$2 and event_type='conversation.routing_requested'",[org,conv])).rows[0];
    expect(pending.status).toBe("pending");expect(pending.attempts).toBe(1);expect(new Date(pending.next_attempt_at).getTime()).toBe(now.getTime()+900000);
    await query("update event_log set payload=jsonb_build_object('conversation_id','not-a-uuid','organization_id',$1::text),next_attempt_at=null where organization_id=$1 and entity_id=$2 and event_type='conversation.routing_requested'",[org,conv]);
    expect((await runRoutingWorker()).outcomes.skipped_invalid_payload).toBe(1);
    expect((await query("select status from event_log where organization_id=$1 and entity_id=$2 and event_type='conversation.routing_requested'",[org,conv])).rows[0].status).toBe("done");
  });
  it("falha após criação preserva identidade e permite retry com novo lease", async () => {
    const key="50000000-0000-4000-8000-000000000001";
    const reserve=()=>asUser(admin,"select fn_reserve_channel_connection($1,$2,$3) r",[org,key,"e".repeat(64)]).then(r=>r.rows[0].r);
    const first=await reserve();
    await query("select fn_finish_channel_connection($1,$2,$3,'remote_created')",[org,first.receipt_id,first.lease_token]);
    const failed=(await query("select fn_finish_channel_connection($1,$2,$3,'FAILED','connection_repair_required') r",[org,first.receipt_id,first.lease_token])).rows[0].r;
    expect(failed.status).toBe("FAILED");expect(failed.archived_at).toBeNull();
    const next=await reserve();expect(next.lease_token).not.toBe(first.lease_token);
    expect(next.channel.id).toBe(first.channel.id);expect(next.channel.waha_session_name).toBe(first.channel.waha_session_name);
    await expect(query("select fn_finish_channel_connection($1,$2,$3,'WORKING')",[org,first.receipt_id,first.lease_token])).rejects.toMatchObject({code:"55P03"});
  });
});
