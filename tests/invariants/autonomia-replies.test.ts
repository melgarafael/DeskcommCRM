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
async function asUser(user: string | null, sql: string, args: unknown[]) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query(user ? "set local role authenticated" : "set local role anon");
    await c.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ sub: user, role: user ? "authenticated" : "anon", aal: "aal1" }),
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
it("SQL humano/RLS: dono positivo; outro ator, viewer, anon e outro tenant negados", async () => {
  const f = await fixture(),
    d = await pending(f);
  for (const user of [GOV_AGENT_B, GOV_VIEWER, null])
    await expect(
      asUser(user, approveSql, [f.org, d.id, String(d.revision), "Olá"]),
    ).rejects.toThrow();
  await expect(
    asUser(GOV_AGENT_A, approveSql, [randomUUID(), d.id, String(d.revision), "Olá"]),
  ).rejects.toThrow();
  expect(
    (await asUser(GOV_AGENT_B, "select id from ai_reply_drafts where organization_id=$1", [f.org]))
      .rows,
  ).toEqual([]);
  expect(await approve(f, d)).toBeTruthy();
});
it("duas aprovações concorrentes idênticas criam exatamente um job; corpo diferente exige nova revisão", async () => {
  const f = await fixture(),
    d = await pending(f);
  const jobs = await Promise.all([approve(f, d), approve(f, d)]);
  expect(jobs[0]).toBe(jobs[1]);
  expect(
    (
      await pool.query(
        "select count(*)::int n from job_queue where organization_id=$1 and kind='approved_reply'",
        [f.org],
      )
    ).rows[0].n,
  ).toBe(1);
  await expect(
    asUser(GOV_AGENT_A, approveSql, [f.org, d.id, String(d.revision), "Outro texto"]),
  ).rejects.toThrow("reply_stale");
  expect(
    (
      await pool.query(
        "select bot_silenced_until,assigned_to_user_id from conversations where id=$1",
        [f.conversation],
      )
    ).rows[0],
  ).toMatchObject({ bot_silenced_until: null, assigned_to_user_id: GOV_AGENT_A });
});
it("inbound distinto mesmo timestamp ou fora de ordem invalida; replay não e histórico não despacha", async () => {
  const f = await fixture(),
    d = await pending(f),
    external = randomUUID();
  const insert =
    "insert into messages(organization_id,contact_id,conversation_id,channel_session_id,direction,type,body,status,external_id,sent_at) values($1,$2,$3,$4,'inbound','text','Oi','received',$5,$6)";
  await pool.query(insert, [
    f.org,
    f.contact,
    f.conversation,
    f.channel,
    external,
    "2026-09-01T10:00:00Z",
  ]);
  expect(await current(f, d.id)).toBe(false);
  const rev = async () =>
    String(
      (
        await pool.query("select reply_context_revision from conversations where id=$1", [
          f.conversation,
        ])
      ).rows[0].reply_context_revision,
    );
  const initial = await rev();
  await expect(pool.query(insert, [
    f.org,
    f.contact,
    f.conversation,
    f.channel,
    external,
    "2026-09-01T10:00:00Z",
  ])).rejects.toMatchObject({code:"23505"});
  expect(await rev()).toBe(initial);
  await pool.query(insert, [
    f.org,
    f.contact,
    f.conversation,
    f.channel,
    randomUUID(),
    "2026-09-01T10:00:00Z",
  ]);
  expect(BigInt(await rev())).toBe(BigInt(initial) + 1n);
  await pool.query(insert, [
    f.org,
    f.contact,
    f.conversation,
    f.channel,
    randomUUID(),
    "2026-08-01T10:00:00Z",
  ]);
  expect(BigInt(await rev())).toBe(BigInt(initial) + 2n);
  expect(
    (
      await pool.query(
        "select id from job_queue where organization_id=$1 and kind='inbound_turn'",
        [f.org],
      )
    ).rows,
  ).toEqual([]);
});
it("ABA de modo, pausa, assignment e canal não ressuscita a sugestão anterior", async () => {
  for (const change of ["mode", "pause", "assignment", "channel"]) {
    const f = await fixture(),
      d = await pending(f);
    if (change === "mode") {
      await pool.query("update ai_agents set operation_mode='automatic' where id=$1", [f.agent]);
      await pool.query("update ai_agents set operation_mode='assisted' where id=$1", [f.agent]);
    }
    if (change === "pause") {
      await pool.query("update ai_agents set paused_at=now() where id=$1", [f.agent]);
      await pool.query("update ai_agents set paused_at=null where id=$1", [f.agent]);
    }
    if (change === "assignment") {
      await pool.query("update conversations set assigned_to_user_id=$1 where id=$2", [
        GOV_AGENT_B,
        f.conversation,
      ]);
      await pool.query("update conversations set assigned_to_user_id=$1 where id=$2", [
        GOV_AGENT_A,
        f.conversation,
      ]);
    }
    if (change === "channel") {
      await pool.query("update channel_sessions set status='STOPPED' where id=$1", [f.channel]);
      await pool.query("update channel_sessions set status='WORKING' where id=$1", [f.channel]);
    }
    expect(await current(f, d.id), change).toBe(false);
    await expect(approve(f, d)).rejects.toThrow("reply_stale");
  }
});
it("pausa conserva a publicação e admite uma nova assistência; aprovação não muda flags de autonomia", async () => {
  const f = await fixture();
  await pool.query("update ai_agents set paused_at=now() where id=$1", [f.agent]);
  await pool.query("update contacts set force_human=true where id=$1", [f.contact]);
  const d = await pending(f),
    job = await approve(f, d),
    args = await claim(f, job);
  const policy = (await pool.query("select fn_reply_delivery_policy($1,$2,$3,$4) p", args)).rows[0]
    .p;
  expect(policy.current).toBe(true);
  expect(policy.context_current).toBe(true);
  expect(
    (await pool.query("select published_version_id from ai_agents where id=$1", [f.agent])).rows[0]
      .published_version_id,
  ).toBe(f.version);
  expect(
    (await pool.query("select force_human from contacts where id=$1", [f.contact])).rows[0]
      .force_human,
  ).toBe(true);
});
it("claim original preserva microssegundos; reclaim impede prepare e settle antigos", async () => {
  const f = await fixture(),
    d = await pending(f),
    job = await approve(f, d),
    args = await claim(f, job);
  expect((await pool.query("select fn_reply_prepare($1,$2,$3,$4) ready", args)).rows[0].ready).toBe(
    true,
  );
  await pool.query(
    "update job_queue set locked_at=locked_at+interval '1 microsecond' where id=$1",
    [job],
  );
  expect((await pool.query("select fn_reply_prepare($1,$2,$3,$4) ready", args)).rows[0].ready).toBe(
    false,
  );
  expect(
    (await pool.query("select fn_reply_settle($1,$2,$3,$4,'failed') settled", args)).rows[0]
      .settled,
  ).toBe(false);
});
it("consumer encerra contexto obsoleto e não aceita sent sem recibo", async () => {
  const f = await fixture(),
    d = await pending(f),
    job = await approve(f, d),
    args = await claim(f, job);
  await pool.query("update contacts set is_blocked=true where id=$1", [f.contact]);
  await pool.query("select fn_reply_settle($1,$2,$3,$4,'queued')", args);
  expect(
    (await pool.query("select status from ai_reply_drafts where id=$1", [d.id])).rows[0].status,
  ).toBe("stale");
  const second = await fixture(),
    d2 = await pending(second),
    job2 = await approve(second, d2),
    args2 = await claim(second, job2);
  await pool.query("select fn_reply_settle($1,$2,$3,$4,'sent')", args2);
  expect(
    (await pool.query("select status from ai_reply_drafts where id=$1", [d2.id])).rows[0].status,
  ).toBe("stale");
});
it("último corte aguarda writer anterior e nega a revisão que ele mudou", async () => {
  const f = await fixture(),
    d = await pending(f),
    job = await approve(f, d),
    args = await claim(f, job),
    writer = await pool.connect();
  try {
    await writer.query("begin");
    await writer.query("update ai_agents set operation_mode='automatic' where id=$1", [f.agent]);
    const prepare = pool.query("select fn_reply_prepare($1,$2,$3,$4) ready", args);
    await writer.query("commit");
    expect((await prepare).rows[0].ready).toBe(false);
  } finally {
    writer.release();
  }
});
it("feedback estruturado preserva correção e nova mensagem admite segunda aprovação independente", async () => {
  const f = await fixture(),
    d = await pending(f);
  await asUser(GOV_AGENT_A, approveSql, [f.org, d.id, String(d.revision), "Texto corrigido"]);
  expect(
    (await pool.query("select feedback from ai_reply_drafts where id=$1", [d.id])).rows[0].feedback,
  ).toMatchObject({ decision: "edited", correction: "Texto corrigido" });
  await pool.query(
    "update conversations set reply_context_revision=reply_context_revision+1 where id=$1",
    [f.conversation],
  );
  const second = await pending(f);
  expect(second.id).not.toBe(d.id);
  expect(await approve(f, second)).toBeTruthy();
});
