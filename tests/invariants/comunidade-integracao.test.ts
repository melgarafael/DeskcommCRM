import pg from "pg";
import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, it, expect } from "vitest";
import { seedGov, GOV_AGENT_A } from "./gov-helpers";
import { replyFixture } from "../support/autonomia-fixture";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 6,
});
beforeAll(() => seedGov());
afterAll(() => pool.end());
async function draft(f: Awaited<ReturnType<typeof replyFixture>>) {
  const { rows } = await pool.query("select * from fn_reply_begin($1,$2,$3,$4,$5)", [
    f.org,
    f.conversation,
    f.agent,
    f.version,
    randomUUID(),
  ]);
  await pool.query(
    "update ai_reply_drafts set status='pending',original_body='SENTINELA REVISÃO',edited_body='SENTINELA EDITADA',feedback=jsonb_build_object('reason','SENTINELA FEEDBACK') where organization_id=$1 and id=$2",
    [f.org, rows[0].id],
  );
  return rows[0];
}
async function unassigned(f: Awaited<ReturnType<typeof replyFixture>>) {
  await pool.query(
    "update conversations set assigned_to_user_id=null,assignee_kind=null,status='open' where organization_id=$1 and id=$2",
    [f.org, f.conversation],
  );
  await pool.query(
    "insert into attendant_availability(organization_id,user_id,is_available,capacity,schedule) values($1,$2,true,5,'{}') on conflict(organization_id,user_id) do update set is_available=true,capacity=5,schedule='{}'",
    [f.org, GOV_AGENT_A],
  );
}
it("0228 atribui pelo canal e invalida a sugestão capturada pela0227", async () => {
  const f = await replyFixture(pool);
  await unassigned(f);
  const d = await draft(f);
  expect(
    (await pool.query("select fn_reply_context_current($1,$2) current", [f.org, d.id])).rows[0]
      .current,
  ).toBe(true);
  expect(
    (
      await pool.query("select fn_channel_routing_claim($1,$2,$3,$4,'{}') outcome", [
        f.org,
        f.conversation,
        f.channel,
        GOV_AGENT_A,
      ])
    ).rows[0].outcome,
  ).toBe("assigned");
  expect(
    (await pool.query("select fn_reply_context_current($1,$2) current", [f.org, d.id])).rows[0]
      .current,
  ).toBe(false);
});
it("claim0228 espera o canal antes de travar conversa que o trigger0227 precisa atualizar", async () => {
  const f = await replyFixture(pool);
  await unassigned(f);
  const writer = await pool.connect(),
    claimant = await pool.connect(),
    probe = await pool.connect();
  let pending: Promise<pg.QueryResult> | undefined;
  try {
    await writer.query("begin");
    await writer.query(
      "select id from channel_sessions where organization_id=$1 and id=$2 for update",
      [f.org, f.channel],
    );
    const pid = (await claimant.query("select pg_backend_pid() pid")).rows[0].pid;
    await claimant.query("set statement_timeout='8s'");
    pending = claimant.query("select fn_channel_routing_claim($1,$2,$3,$4,'{}') outcome", [
      f.org,
      f.conversation,
      f.channel,
      GOV_AGENT_A,
    ]);
    // Install rejection handling immediately; finally still awaits the original operation.
    void pending.catch(() => {});
    await expect
      .poll(
        async () =>
          (await pool.query("select cardinality(pg_blocking_pids($1)) n", [pid])).rows[0].n,
        { timeout: 3000, interval: 20 },
      )
      .toBeGreaterThan(0);
    await probe.query("begin");
    // Old conversation->channel order holds this row while waiting: NOWAIT exposes the cycle.
    await probe.query(
      "select id from conversations where organization_id=$1 and id=$2 for no key update nowait",
      [f.org, f.conversation],
    );
    await probe.query("rollback");
    await writer.query(
      "update channel_sessions set status=case when status='STOPPED' then 'WORKING' else 'STOPPED' end where organization_id=$1 and id=$2",
      [f.org, f.channel],
    );
    await writer.query("commit");
    expect((await pending).rows[0].outcome).toBe("assigned");
  } finally {
    await probe.query("rollback");
    await writer.query("rollback");
    if (pending) await pending.catch(() => {});
    writer.release();
    claimant.release();
    probe.release();
  }
});
it("mutex e cascata0229 alcançam drafts0227 e preservam contato vizinho", async () => {
  const f = await replyFixture(pool),
    neighbor = await replyFixture(pool);
  const own = await draft(f),
    other = await draft(neighbor);
  await pool.query("select fn_lgpd_cascade_redact_contact($1,$2,$3)", [
    f.org,
    f.contact,
    GOV_AGENT_A,
  ]);
  expect(
    (
      await pool.query(
        "select original_body,edited_body,approved_body,feedback,proposals,trace,status,error_code from ai_reply_drafts where organization_id=$1 and id=$2",
        [f.org, own.id],
      )
    ).rows[0],
  ).toEqual({
    original_body: null,
    edited_body: null,
    approved_body: null,
    feedback: null,
    proposals: [],
    trace: [],
    status: "stale",
    error_code: "redacted",
  });
  expect(
    (
      await pool.query(
        "select original_body,feedback from ai_reply_drafts where organization_id=$1 and id=$2",
        [neighbor.org, other.id],
      )
    ).rows[0],
  ).toEqual({ original_body: "SENTINELA REVISÃO", feedback: { reason: "SENTINELA FEEDBACK" } });
  await expect(
    pool.query("select * from fn_reply_begin($1,$2,$3,$4,$5)", [
      f.org,
      f.conversation,
      f.agent,
      f.version,
      randomUUID(),
    ]),
  ).rejects.toThrow("reply_context_unavailable");
});
