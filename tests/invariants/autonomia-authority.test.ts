import { randomUUID } from "node:crypto";
import pg from "pg";
import { beforeAll, afterAll, it, expect } from "vitest";
import { seedGov, GOV_AGENT_A, GOV_AGENT_B, GOV_VIEWER } from "./gov-helpers";
import { criarOrigemDeFollowup } from "./followup-service-origin";
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 6,
});
beforeAll(() => seedGov());
afterAll(() => pool.end());
async function fixture() {
  const org = randomUUID(),
    contact = randomUUID(),
    agent = randomUUID(),
    version = randomUUID();
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Replies','Replies')",
    [org],
  );
  for (const [user, role] of [
    [GOV_AGENT_A, "agent"],
    [GOV_AGENT_B, "agent"],
    [GOV_VIEWER, "viewer"],
  ])
    await pool.query(
      "insert into user_organizations(organization_id,user_id,role,accepted_at) values($1,$2,$3,now())",
      [org, user, role],
    );
  await pool.query("insert into contacts(id,organization_id,name) values($1,$2,'Contato')", [
    contact,
    org,
  ]);
  const boundary = await criarOrigemDeFollowup(pool, org, contact),
    conversation = boundary.conversation_id;
  await pool.query(
    "update conversations set assigned_to_user_id=$1 where organization_id=$2 and id=$3",
    [GOV_AGENT_A, org, conversation],
  );
  const channel = (
    await pool.query(
      "select channel_session_id from conversations where organization_id=$1 and id=$2",
      [org, conversation],
    )
  ).rows[0].channel_session_id;
  await pool.query(
    "insert into ai_agents(id,organization_id,name,system_prompt,operation_mode) values($1,$2,'Assistente','Ajude com informações confirmadas.','assisted')",
    [agent, org],
  );
  await pool.query(
    "insert into ai_agent_versions(id,organization_id,agent_id,version_number,system_prompt,provider,model,channel_session_id,status) values($1,$2,$3,1,'Ajude com informações confirmadas.','anthropic','test-model',$4,'published')",
    [version, org, agent, channel],
  );
  await pool.query(
    "update ai_agents set published_version_id=$1 where organization_id=$2 and id=$3",
    [version, org, agent],
  );
  return { org, contact, agent, version, conversation, channel, boundary };
}
type F = Awaited<ReturnType<typeof fixture>>;
async function begin(f: F) {
  return (
    await pool.query("select * from fn_reply_begin($1,$2,$3,$4,$5)", [
      f.org,
      f.conversation,
      f.agent,
      f.version,
      randomUUID(),
    ])
  ).rows[0];
}
async function pending(f: F) {
  const d = await begin(f);
  await pool.query(
    "update ai_reply_drafts set status='pending',original_body='Olá',edited_body='Olá' where organization_id=$1 and id=$2",
    [f.org, d.id],
  );
  return d;
}
async function asUser(
  user: string | null,
  sql: string,
  args: unknown[],
  session?: string,
  aal = "aal1",
) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query(user ? "set local role authenticated" : "set local role anon");
    await c.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({
        sub: user,
        role: user ? "authenticated" : "anon",
        aal,
        session_id: session,
      }),
    ]);
    const r = await c.query(sql, args);
    await c.query("commit");
    return r;
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}
const approveSql = "select fn_reply_action($1,$2,$3,'approve',$4,null) as job";
async function approve(f: F, d: Record<string, unknown>) {
  return (await asUser(GOV_AGENT_A, approveSql, [f.org, d.id, String(d.revision), "Olá"])).rows[0]
    .job as string;
}
async function claim(f: F, job: string) {
  await pool.query(
    "update job_queue set status='running',locked_by='reply-test',locked_at='2026-09-07 12:00:00.123456+00',attempts=1 where organization_id=$1 and id=$2",
    [f.org, job],
  );
  return [f.org, job, "reply-test", "2026-09-07 12:00:00.123456+00"];
}
async function current(f: F, id: unknown) {
  return (await pool.query("select fn_reply_context_current($1,$2) as current", [f.org, id]))
    .rows[0].current;
}

it("MFA é prova da sessão: fator verificado nega aal1 e aceita aal2", async () => {
  const f = await fixture(),
    d = await pending(f),
    factor = randomUUID();
  await pool.query(
    "insert into auth.mfa_factors(id,user_id,status,factor_type) values($1,$2,'verified','totp')",
    [factor, GOV_AGENT_A],
  );
  try {
    await expect(
      asUser(GOV_AGENT_A, approveSql, [f.org, d.id, String(d.revision), "Olá"]),
    ).rejects.toThrow("reply_forbidden");
    expect(
      (
        await asUser(
          GOV_AGENT_A,
          approveSql,
          [f.org, d.id, String(d.revision), "Olá"],
          undefined,
          "aal2",
        )
      ).rows[0].job,
    ).toBeTruthy();
  } finally {
    await pool.query("delete from auth.mfa_factors where id=$1", [factor]);
  }
});
async function support() {
  const f = await fixture(),
    session = randomUUID(),
    support = randomUUID();
  await pool.query("delete from user_organizations where organization_id=$1 and user_id=$2", [
    f.org,
    GOV_AGENT_B,
  ]);
  await pool.query("insert into auth.sessions(id,user_id,aal) values($1,$2,'aal1')", [
    session,
    GOV_AGENT_B,
  ]);
  await pool.query(
    "insert into platform_admins(user_id,granted_by,scope,mfa_required,reason) values($1,$1,'full',false,'Replies test') on conflict(user_id) do update set scope='full',revoked_at=null,mfa_required=false",
    [GOV_AGENT_B],
  );
  await pool.query(
    "insert into platform_support_sessions(id,organization_id,actor_user_id,auth_session_id,access_mode,expires_at) values($1,$2,$3,$4,'full',now()+interval '30 minutes')",
    [support, f.org, GOV_AGENT_B, session],
  );
  return { ...f, session, support };
}
it("suporte full sem membership aprova e entrega; referência original revoga ao expirar/encerrar/downgrade", async () => {
  for (const mutation of ["expires", "ends", "scope", "mode", "session"]) {
    const f = await support(),
      d = await pending(f);
    const job = (
        await asUser(GOV_AGENT_B, approveSql, [f.org, d.id, String(d.revision), "Olá"], f.session)
      ).rows[0].job,
      args = await claim(f, job);
    const policy = async () =>
      (await pool.query("select fn_reply_delivery_policy($1,$2,$3,$4) p", args)).rows[0].p;
    expect((await policy()).current).toBe(true);
    expect(
      (
        await pool.query("select approved_support_session_id from ai_reply_drafts where id=$1", [
          d.id,
        ])
      ).rows[0].approved_support_session_id,
    ).toBe(f.support);
    if (mutation === "expires")
      await pool.query(
        "update platform_support_sessions set expires_at=now()-interval '1 minute' where id=$1",
        [f.support],
      );
    if (mutation === "ends")
      await pool.query("update platform_support_sessions set ended_at=now() where id=$1", [
        f.support,
      ]);
    if (mutation === "scope")
      await pool.query("update platform_admins set scope='support_readonly' where user_id=$1", [
        GOV_AGENT_B,
      ]);
    if (mutation === "mode")
      await pool.query(
        "update platform_support_sessions set access_mode='support_readonly' where id=$1",
        [f.support],
      );
    if (mutation === "session")
      await pool.query("update auth.sessions set not_after=now()-interval '1 minute' where id=$1", [
        f.session,
      ]);
    expect((await policy()).current, mutation).toBe(false);
  }
});
it("suporte readonly/expirado nega aprovação e outra sessão não substitui a original", async () => {
  const f = await support(),
    d = await pending(f);
  await pool.query(
    "update platform_support_sessions set access_mode='support_readonly' where id=$1",
    [f.support],
  );
  await expect(
    asUser(GOV_AGENT_B, approveSql, [f.org, d.id, String(d.revision), "Olá"], f.session),
  ).rejects.toThrow("reply_forbidden");
  await pool.query(
    "update platform_support_sessions set access_mode='full',expires_at=now()-interval '1 minute' where id=$1",
    [f.support],
  );
  await expect(
    asUser(GOV_AGENT_B, approveSql, [f.org, d.id, String(d.revision), "Olá"], f.session),
  ).rejects.toThrow("reply_forbidden");
  await expect(
    asUser(GOV_AGENT_B, approveSql, [f.org, d.id, String(d.revision), "Olá"], randomUUID()),
  ).rejects.toThrow("reply_forbidden");
});
it("redação limpa todos os corpos/propostas/feedback e encerra job sem reenvio", async () => {
  const f = await fixture(),
    d = await pending(f),
    job = await approve(f, d);
  await pool.query("update ai_reply_drafts set proposals=$1 where id=$2", [
    JSON.stringify([{ tool: "write", arguments: { name: "pessoal" } }]),
    d.id,
  ]);
  await pool.query("select fn_service_lock($1,$2)", [f.org, f.contact]);
  await pool.query("update contacts set is_anonymized=true,anonymized_at=now() where id=$1", [
    f.contact,
  ]);
  expect(
    (
      await pool.query(
        "select original_body,approved_body,edited_body,feedback,proposals,status from ai_reply_drafts where id=$1",
        [d.id],
      )
    ).rows[0],
  ).toMatchObject({
    original_body: null,
    approved_body: null,
    edited_body: null,
    feedback: null,
    proposals: [],
    status: "stale",
  });
  expect(
    (await pool.query("select status,payload from job_queue where id=$1", [job])).rows[0],
  ).toMatchObject({ status: "failed", payload: {} });
});
