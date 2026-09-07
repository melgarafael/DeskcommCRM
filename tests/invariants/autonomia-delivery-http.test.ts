import {claimJobs,reapExpiredJobs} from '@/lib/agent-engine/queue/queue';
import { meetPgSupabase } from "../support/meet-pg-supabase";
import { createAdminClient } from "@/lib/supabase/admin";
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
import { createApprovedReplyHandler } from "@/lib/agent-engine/agent/approved-reply";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { beforeAll, afterAll, it, expect, vi } from "vitest";
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
async function setup() {
  const f = await fixture();
  await pool.query(
    "update contacts set phone_number='+5531998765432',force_human=true where id=$1",
    [f.contact],
  );
  await pool.query(
    "insert into channel_knobs(organization_id,channel_session_id,throttle_ms,jitter_max_ms,window_start_hour,window_end_hour) values($1,$2,0,0,0,24)",
    [f.org, f.channel],
  );
  const d = await pending(f),
    jid = await approve(f, d);
  await claim(f, jid);
  const job = (
    await pool.query("select *,locked_at::text claim_acquired_at from job_queue where id=$1", [jid])
  ).rows[0];
  return { f, d, job };
}
async function receiverRun(
  s: Awaited<ReturnType<typeof setup>>,
  mode: "pause" | "reclaim" | "redact" | "crash" | "normal" | "receipt_lost_pause" | "receipt_lost_max",
) {
  const { createServer } = await import("node:http");
  let posts = 0,
    receiverError: unknown;
  const receiver = createServer(async (req, res) => {
    try {
      if (req.method === "GET") {
        res.end(JSON.stringify({ numberExists: true, chatId: "5531998765432@c.us" }));
        return;
      }
      for await (const _ of req) {
      }
      posts++;
      if (mode === "pause" || mode === "receipt_lost_pause")
        await pool.query("update ai_agents set paused_at=now() where id=$1", [s.f.agent]);
      if (mode === "reclaim")
        await pool.query("update job_queue set locked_at=clock_timestamp() where id=$1", [
          s.job.id,
        ]);
      if (mode === "redact")
        await pool.query("update contacts set is_anonymized=true,anonymized_at=now() where id=$1", [
          s.f.contact,
        ]);
      res.end(JSON.stringify({ id: "receipt-accepted-" + s.job.id }));
    } catch (e) {
      receiverError = e;
      res.statusCode = 500;
      res.end("{}");
    }
  });
  await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
  const a = receiver.address();
  if (!a || typeof a === "string") throw Error("receiver");
  const url = process.env.WAHA_API_BASE_URL,
    key = process.env.WAHA_API_KEY;
  process.env.WAHA_API_BASE_URL = `http://127.0.0.1:${a.port}`;
  process.env.WAHA_API_KEY = "test-receiver";
  const db = meetPgSupabase(pool);
  let lostResponses = 0;
  let committedReceipt: Record<string, unknown> | undefined;
  const deliveryDb = new Proxy(db.client, {
    get(target, key) {
      if (key === "rpc")
        return async (name: string, args: Record<string, unknown>) => {
          const result = await target.rpc(name, args);
          if (
            (mode === "receipt_lost_pause" || mode === "receipt_lost_max") &&
            name === "fn_reply_record_receipt" && !result.error && result.data
          ) {
            // The real RPC has returned after committing. Lose only its response.
            committedReceipt = (await pool.query(
              `select l.id,l.status,l.crm_message_id,m.status message_status,m.external_id
               from send_ledger l join messages m on m.organization_id=l.organization_id and m.id=l.crm_message_id
               where l.organization_id=$1 and l.job_id=$2 and l.seq=1`,
              [s.f.org, s.job.id],
            )).rows[0];
            lostResponses++;
            throw Error("receipt_response_lost_after_commit");
          }
          return result;
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  vi.mocked(createAdminClient).mockReturnValue(deliveryDb as never);
  const executionPool =
    mode === "crash"
      ? new Proxy(pool, {
          get(target, k) {
            if (k === "query")
              return (text: string, args: unknown[]) => {
                if (text.includes("fn_reply_settle") && args[4] === "sent")
                  throw Error("transient_settle_failure");
                return target.query(text, args);
              };
            const v = Reflect.get(target, k);
            return typeof v === "function" ? v.bind(target) : v;
          },
        })
      : pool;
  try {
    const run = createApprovedReplyHandler({
      crmCfg: { supabase: deliveryDb },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      sleep: async () => {},
    })(s.job, executionPool);
    if (mode === "crash") await expect(run).rejects.toThrow("transient_settle_failure");
    else await run;
    expect(receiverError).toBeUndefined();
    return { posts, errors: db.errors, lostResponses, committedReceipt };
  } finally {
    if (url === undefined) delete process.env.WAHA_API_BASE_URL;
    else process.env.WAHA_API_BASE_URL = url;
    if (key === undefined) delete process.env.WAHA_API_KEY;
    else process.env.WAHA_API_KEY = key;
    receiver.closeAllConnections();
    await new Promise<void>((r) => receiver.close(() => r()));
  }
}
it("pausa durante POST preserva receipt e reconhece envio humano sem ativar autonomia", async () => {
  const s = await setup(),
    r = await receiverRun(s, "pause");
  expect(r.posts, JSON.stringify(r.errors)).toBe(1);
  expect(
    (await pool.query("select status from ai_reply_drafts where id=$1", [s.d.id])).rows[0].status,
  ).toBe("sent");
  expect(
    (
      await pool.query(
        "select status,external_id from messages where organization_id=$1 and direction='outbound'",
        [s.f.org],
      )
    ).rows[0],
  ).toMatchObject({ status: "sent", external_id: "receipt-accepted-" + s.job.id });
  expect(
    (await pool.query("select force_human from contacts where id=$1", [s.f.contact])).rows[0]
      .force_human,
  ).toBe(true);
});
it.each(["reclaim", "redact"] as const)("callback nega %s sem reidratar dados", async (mode) => {
  const s = await setup(),
    r = await receiverRun(s, mode);
  expect(r.posts, JSON.stringify(r.errors)).toBe(1);
  expect(
    (
      await pool.query(
        "select count(*)::int n from messages where organization_id=$1 and external_id=$2",
        [s.f.org, "receipt-accepted-" + s.job.id],
      )
    ).rows[0].n,
  ).toBe(0);
  expect(
    (await pool.query("select status from ai_reply_drafts where id=$1", [s.d.id])).rows[0].status,
  ).not.toBe("sent");
});
it("settle transiente após accepted permanece recuperável e não repete POST", async () => {
  const s = await setup();
  s.job=(await pool.query("update job_queue set attempts=max_attempts,locked_at=now()-interval '20 minutes' where id=$1 returning *,locked_at::text claim_acquired_at",[s.job.id])).rows[0];
  const originalClaim=s.job.claim_acquired_at;
  const first = await receiverRun(s, "crash");
  expect(first.posts, JSON.stringify(first.errors)).toBe(1);
  expect(
    (await pool.query("select status from job_queue where id=$1", [s.job.id])).rows[0].status,
  ).toBe("running");
  expect(
    (await pool.query("select status from send_ledger where job_id=$1", [s.job.id])).rows[0].status,
  ).toBe("accepted");
  await reapExpiredJobs(pool,{visibilityTimeoutMs:1});
  expect((await pool.query('select status from job_queue where id=$1',[s.job.id])).rows[0].status).toBe('pending');
  const next=(await claimJobs(pool,{workerId:'new-reply-worker',maxConcurrency:20,batchSize:20})).find(j=>j.id===s.job.id);
  expect(next).toBeDefined();
  expect(next!.claim_acquired_at).not.toBe(originalClaim);
  s.job=next!;
  const second = await receiverRun(s, "normal");
  expect(second.posts).toBe(0);
  expect(
    (await pool.query("select status from ai_reply_drafts where id=$1", [s.d.id])).rows[0].status,
  ).toBe("sent");
});

it.each(["receipt_lost_pause", "receipt_lost_max"] as const)(
  "%s: resposta perdida após commit reconhece accepted sem repetir POST",
  async (mode) => {
    const s = await setup();
    if (mode === "receipt_lost_max")
      s.job = (await pool.query(
        "update job_queue set attempts=max_attempts where id=$1 returning *,locked_at::text claim_acquired_at",
        [s.job.id],
      )).rows[0];
    const first = await receiverRun(s, mode);
    expect(first.posts, JSON.stringify(first.errors)).toBe(1);
    expect(first.lostResponses).toBe(1);
    expect(first.committedReceipt).toMatchObject({
      status: "accepted", message_status: "sent", external_id: "receipt-accepted-" + s.job.id,
    });
    expect((await pool.query(
      "select status,message_id from ai_reply_drafts where organization_id=$1 and id=$2",
      [s.f.org, s.d.id],
    )).rows[0]).toEqual({ status: "sent", message_id: first.committedReceipt!.crm_message_id });
    expect((await pool.query(
      "select status,attempts from job_queue where organization_id=$1 and id=$2",
      [s.f.org, s.job.id],
    )).rows[0]).toEqual({ status: "done", attempts: s.job.attempts });
    expect((await pool.query("select force_human from contacts where id=$1", [s.f.contact])).rows[0].force_human).toBe(true);
    const second = await receiverRun(s, "normal");
    expect(second.posts).toBe(0);
    expect((await pool.query(
      `select l.id,l.status,l.crm_message_id,m.status message_status,m.external_id
       from send_ledger l join messages m on m.organization_id=l.organization_id and m.id=l.crm_message_id
       where l.organization_id=$1 and l.job_id=$2 and l.seq=1`,
      [s.f.org, s.job.id],
    )).rows).toEqual([first.committedReceipt]);
    expect((await pool.query(
      "select count(*)::int n from messages where organization_id=$1 and direction='outbound'",
      [s.f.org],
    )).rows[0].n).toBe(1);
  },
);
