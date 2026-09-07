import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, expect, it } from "vitest";
import { criarOrigemDeFollowup } from "./followup-service-origin";

const pool = new pg.Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`, max: 5 });
afterAll(() => pool.end());
async function fixture() {
  const org = randomUUID(), contact = randomUUID(), appointment = randomUUID(), user = randomUUID(), control = randomUUID(), job = randomUUID();
  await pool.query("insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Locks LGPD','Locks LGPD')", [org]);
  await pool.query("insert into auth.users(id,email) values($1,$2)", [user, `${user}@invariant.test`]);
  await pool.query("insert into user_organizations(organization_id,user_id,role,accepted_at) values($1,$2,'admin',now())", [org, user]);
  await pool.query("insert into contacts(id,organization_id,name,display_name) values($1,$3,'PESSOAL-ALVO','PESSOAL-ALVO'),($2,$3,'CONTROLE-INTACTO','CONTROLE-INTACTO')", [contact, control, org]);
  await pool.query("insert into calendar_appointments(id,organization_id,contact_id,title,starts_at,ends_at,status) values($1,$2,$3,'PESSOAL-ALVO',now()+interval '1 day',now()+interval '1 day 1 hour','confirmed')", [appointment, org, contact]);
  await pool.query("insert into job_queue(id,organization_id,contact_id,kind,payload) values($1,$2,$3,'transactional_delivery',$4)", [job, org, contact, { appointment_id: appointment }]);
  await pool.query("insert into agent_inbox_items(organization_id,kind,ref_kind,ref_id,title,body) values($1,'other','appointment',$2,'Aviso','PESSOAL-ALVO')", [org, appointment]);
  return { org, contact, appointment, user, control, job };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const canonical = "select fn_lgpd_cascade_redact_contact($1,$2,$3) result";
const legacy = "select fn_lgpd_anonymize_contact($1,$2) result";
async function claims(client: pg.PoolClient, user: string | null, aal = "aal1", session?: string) {
  await client.query(user ? "set local role authenticated" : "set local role service_role");
  await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role: user ? "authenticated" : "service_role", ...(user ? { sub: user, aal } : {}), ...(session ? { session_id: session } : {}) })]);
}
async function state(f: Fixture) {
  return (await pool.query("select jsonb_build_object('contact',(select to_jsonb(c) from contacts c where id=$1),'appointment',(select to_jsonb(a) from calendar_appointments a where id=$2),'job',(select to_jsonb(j) from job_queue j where id=$3),'control',(select to_jsonb(c) from contacts c where id=$4)) data", [f.contact, f.appointment, f.job, f.control])).rows[0].data;
}
async function waitForMutex(observer: pg.PoolClient, waitingPid: number, ownerPid: number) {
  await expect.poll(async () => {
    const row = (await observer.query("select wait_event,pg_blocking_pids(pid) blockers from pg_stat_activity where pid=$1", [waitingPid])).rows[0];
    return row?.wait_event === "advisory" && row.blockers.includes(ownerPid);
  }, { timeout: 5000, interval: 10 }).toBe(true);
}

it("notice direto não espera depois de locks de redação e retry não recria a referência", async () => {
  const f = await fixture(), a = await pool.connect(), b = await pool.connect();
  try {
    await a.query("begin; set local statement_timeout='5s'");
    await a.query("select fn_service_lock($1,$2)", [f.org, f.contact]);
    await a.query(canonical, [f.org, f.contact, randomUUID()]);
    await b.query("begin; set local statement_timeout='2s'");
    await expect(b.query("select fn_meet_notice($1,$2,'retry')", [f.org, f.appointment])).rejects.toMatchObject({ code: "40001" });
    await b.query("rollback");
    await a.query("commit");
    await b.query("select fn_meet_notice($1,$2,'retry')", [f.org, f.appointment]);
    expect((await pool.query("select count(*)::int n from agent_inbox_items where organization_id=$1 and ref_kind='appointment' and ref_id=$2", [f.org, f.appointment])).rows[0].n).toBe(0);
    expect((await state(f)).contact.is_anonymized).toBe(true);
  } finally { await a.query("rollback"); await b.query("rollback"); a.release(); b.release(); }
});

it("sweep não publica snapshot anterior enquanto o mutex da redação está ocupado", async () => {
  const f = await fixture(), a = await pool.connect(), b = await pool.connect();
  await pool.query("update calendar_appointments set starts_at=now()-interval '3 hours',ends_at=now()-interval '2 hours',confirmation_next_at=null where id=$1", [f.appointment]);
  try {
    await a.query("begin; set local statement_timeout='5s'");
    await a.query("select fn_service_lock($1,$2)", [f.org, f.contact]);
    // B ainda enxerga contato não anonimizado; deve revalidar o mutex antes de produzir.
    await b.query("select fn_appointment_confirmation_sweep(500,now())");
    expect((await pool.query("select count(*)::int n from agent_inbox_items where ref_id=$1 and kind='appointment_outcome_required'", [f.appointment])).rows[0].n).toBe(0);
    await a.query(canonical, [f.org, f.contact, randomUUID()]);
    await a.query("commit");
    await b.query("select fn_appointment_confirmation_sweep(500,now()+interval '3 days')");
    expect((await pool.query("select count(*)::int n from agent_inbox_items where ref_kind='appointment' and ref_id=$1", [f.appointment])).rows[0].n).toBe(0);
  } finally { await a.query("rollback"); a.release(); b.release(); }
});

it.each(["canonical", "legacy", "raw-prelock"] as const)("%s espera mutex antes de tocar contato/compromisso e termina após a mutação real", async path => {
  const f = await fixture(), before = await state(f);
  const a = await pool.connect(), b = await pool.connect(), observer = await pool.connect();
  const apid = (await a.query("select pg_backend_pid() pid")).rows[0].pid;
  const bpid = (await b.query("select pg_backend_pid() pid")).rows[0].pid;
  let pending: Promise<{ error?: unknown; result?: pg.QueryResult }> | undefined;
  try {
    for (const client of [a, b]) await client.query("begin; set local statement_timeout='10s'");
    await a.query("select fn_service_lock($1,$2)", [f.org, f.contact]);
    await claims(b, path === "legacy" ? f.user : null);
    pending = (async () => {
      if (path === "canonical") return b.query(canonical, [f.org, f.contact, randomUUID()]);
      if (path === "legacy") return b.query(legacy, [f.org, f.contact]);
      await b.query("select fn_service_lock($1,$2)", [f.org, f.contact]);
      return b.query("update contacts set is_anonymized=true,anonymized_at=coalesce(anonymized_at,now()) where organization_id=$1 and id=$2", [f.org, f.contact]);
    })().then(result => ({ result }), error => ({ error }));
    await waitForMutex(observer, bpid, apid);
    await observer.query("begin");
    try {
      await observer.query("select id from contacts where id=$1 for update nowait", [f.contact]);
      await observer.query("select id from calendar_appointments where id=$1 for update nowait", [f.appointment]);
    } finally { await observer.query("rollback"); }
    const changed = await a.query("select fn_appointment_change($1,$2,1,$3) result", [f.org, f.appointment, { starts_at: "2030-01-01T12:00:00Z", ends_at: "2030-01-01T13:00:00Z" }]);
    expect(changed.rows[0].result.revision).toBe(2);
    await a.query("commit");
    const outcome = await pending;
    expect(outcome.error).toBeUndefined();
    await b.query("commit");
    const after = await state(f);
    expect(after.contact.is_anonymized).toBe(true);
    expect(after.appointment.title).not.toContain("PESSOAL-ALVO");
    expect(after.appointment.google_claim_token).toBeNull();
    expect(after.job).toMatchObject({ id: f.job, payload: {}, status: "failed", locked_by: null });
    expect(after.control).toEqual(before.control);
  } finally {
    await observer.query("select pg_cancel_backend($1)", [bpid]);
    await a.query("rollback");
    await pending;
    await b.query("rollback");
    await observer.query("rollback");
    a.release(); b.release(); observer.release();
  }
});

it.each([[false, true], [true, true], [true, false]])("UPDATE cru true anterior=%s atribui flag=%s falha 40001 sem efeito e aceita retry da transação inteira", async (already, assignsFlag) => {
  const f = await fixture();
  if (already) await pool.query("update contacts set is_anonymized=true,anonymized_at=coalesce(anonymized_at,now()) where id=$1", [f.contact]);
  const before = await state(f), a = await pool.connect(), b = await pool.connect();
  try {
    await a.query("begin; set local statement_timeout='5s'");
    await b.query("begin; set local statement_timeout='2s'");
    await a.query("select fn_service_lock($1,$2)", [f.org, f.contact]);
    await claims(b, null);
    const update = assignsFlag
      ? "update contacts set is_anonymized=true,anonymized_at=coalesce(anonymized_at,now()),name='NÃO-COMMITAR' where organization_id=$1 and id=$2"
      : "update contacts set name='NÃO-COMMITAR' where organization_id=$1 and id=$2";
    await expect(b.query(update, [f.org, f.contact])).rejects.toMatchObject({ code: "40001" });
    await b.query("rollback");
    expect(await state(f)).toEqual(before);
    await a.query("commit");
    await b.query("begin");
    await claims(b, null);
    await b.query("update contacts set is_anonymized=true,anonymized_at=coalesce(anonymized_at,now()) where organization_id=$1 and id=$2", [f.org, f.contact]);
    await b.query("commit");
    expect((await state(f)).contact.is_anonymized).toBe(true);
  } finally { await a.query("rollback"); await b.query("rollback"); a.release(); b.release(); }
});

it("inbound real usa mutex antes das FKs e a cascata seguinte redige a mensagem", async () => {
  const f = await fixture(), boundary = await criarOrigemDeFollowup(pool, f.org, f.contact), message = randomUUID();
  const channel = (await pool.query("select channel_session_id from conversations where id=$1", [boundary.conversation_id])).rows[0].channel_session_id;
  const a = await pool.connect(), b = await pool.connect(), observer = await pool.connect();
  const apid = (await a.query("select pg_backend_pid() pid")).rows[0].pid, bpid = (await b.query("select pg_backend_pid() pid")).rows[0].pid;
  let pending: Promise<unknown> | undefined;
  try {
    await a.query("begin; set local statement_timeout='10s'");
    await b.query("begin; set local statement_timeout='10s'");
    await a.query("select fn_service_lock($1,$2)", [f.org, f.contact]);
    pending = b.query(canonical, [f.org, f.contact, randomUUID()]).then(result => ({ result }), error => ({ error }));
    await waitForMutex(observer, bpid, apid);
    await a.query("insert into messages(id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,sent_via,body,sent_at) values($1,$2,$3,$4,$5,'text','inbound','received','ai','PESSOAL-INBOUND',clock_timestamp())", [message, f.org, boundary.conversation_id, channel, f.contact]);
    await a.query("commit");
    expect(await pending).not.toHaveProperty("error");
    await b.query("commit");
    const stored = (await pool.query("select body,contact_id,conversation_id from messages where id=$1", [message])).rows[0];
    expect(stored).toMatchObject({ body: "[mensagem anonimizada]", contact_id: f.contact, conversation_id: boundary.conversation_id });
  } finally {
    await observer.query("select pg_cancel_backend($1)", [bpid]);
    await a.query("rollback"); await pending; await b.query("rollback");
    a.release(); b.release(); observer.release();
  }
});

it("porta legada preserva timestamp/retomada e cerca papel, tenant, suporte e MFA diretamente", async () => {
  const f = await fixture(), other = await fixture(), factor = randomUUID(), session = randomUUID(), support = randomUUID();
  const call = async (who: string | null, org = f.org, contact = f.contact, aal = "aal1", supportSession?: string) => {
    const client = await pool.connect();
    try {
      await client.query("begin"); await claims(client, who, aal, supportSession);
      const result = await client.query(legacy, [org, contact]); await client.query("commit"); return result.rows[0].result;
    } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
  };
  const original = await state(f);
  await expect(call(null)).rejects.toMatchObject({ code: "42501" });
  await expect(call(other.user)).rejects.toMatchObject({ code: "42501" });
  await expect(call(f.user, f.org, other.contact)).rejects.toMatchObject({ code: "P0002" });
  await pool.query("update user_organizations set role='manager' where organization_id=$1 and user_id=$2", [f.org, f.user]);
  await expect(call(f.user)).rejects.toMatchObject({ code: "42501" });
  await pool.query("update user_organizations set role='admin' where organization_id=$1 and user_id=$2", [f.org, f.user]);
  await pool.query("insert into auth.mfa_factors(id,user_id,status,factor_type) values($1,$2,'verified','totp')", [factor, f.user]);
  try {
    await expect(call(f.user)).rejects.toMatchObject({ code: "42501" });
    expect(await state(f)).toEqual(original);
    const first = await call(f.user, f.org, f.contact, "aal2");
    expect(first).toMatchObject({ already_anonymized: false });
    expect(first.anonymized_at).toBeTruthy();
    const repeated = await call(f.user, f.org, f.contact, "aal2");
    expect(repeated).toEqual({ already_anonymized: true, anonymized_at: first.anonymized_at });
  } finally { await pool.query("delete from auth.mfa_factors where id=$1", [factor]); }
  // Plataforma fora do suporte mantém a porta; dentro do alvo readonly não passa nem com membership admin.
  await pool.query("insert into platform_admins(user_id,granted_by,scope,mfa_required,reason) values($1,$1,'full',false,'ACL LGPD')", [f.user]);
  await pool.query("insert into auth.sessions(id,user_id,aal) values($1,$2,'aal1')", [session, f.user]);
  await pool.query("insert into platform_support_sessions(id,organization_id,actor_user_id,auth_session_id,access_mode,expires_at) values($1,$2,$3,$4,'support_readonly',now()+interval '30 minutes')", [support, f.org, f.user, session]);
  try {
    await expect(call(f.user, f.org, f.control, "aal1", session)).rejects.toMatchObject({ code: "42501" });
    await pool.query("update platform_support_sessions set access_mode='full' where id=$1", [support]);
    expect((await call(f.user, f.org, f.control, "aal1", session)).already_anonymized).toBe(false);
    await pool.query("update platform_support_sessions set expires_at=now()-interval '1 second' where id=$1", [support]);
    await expect(call(f.user, f.org, f.control, "aal1", session)).rejects.toMatchObject({ code: "42501" });
    expect((await call(f.user, other.org, other.contact)).already_anonymized).toBe(false);
  } finally {
    await pool.query("delete from platform_support_sessions where id=$1", [support]);
    await pool.query("delete from auth.sessions where id=$1", [session]);
    await pool.query("delete from platform_admins where user_id=$1", [f.user]);
  }
});
