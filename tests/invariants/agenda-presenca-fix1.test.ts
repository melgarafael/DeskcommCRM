import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, expect, it, vi } from "vitest";
import { criarOrigemDeFollowup } from "./followup-service-origin";
import { assertAgendaEffectPg } from "@/lib/agenda/efeito";
import { StaleServiceBoundaryError } from "@/lib/atendimento/fronteira";
import { completeTurnForEnrollment, createPgAdminClient } from "@/lib/followup/turn-bridge";
import {
  cancelJob,
  completeJob,
  failJob,
  reapExpiredJobs,
  rescheduleJob,
} from "@/lib/agent-engine/queue/queue";
import { claimOfJob } from "@/lib/agent-engine/queue/claim";
import { pgSendLedger, sendWithLedger } from "@/lib/agent-engine/edge/crm/send-ledger";
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 4,
});
afterAll(() => pool.end());
async function fixture() {
  const org = randomUUID();
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Fix presença','Fix presença')",
    [org],
  );
  const contact = (
    await pool.query(
      "insert into contacts(organization_id,display_name) values($1,'Cliente') returning id",
      [org],
    )
  ).rows[0].id;
  const boundary = await criarOrigemDeFollowup(pool, org, contact);
  const graph = {
    nodes: [
      {
        id: "send",
        type: "action",
        label: "Enviar",
        position: { x: 0, y: 0 },
        config: { mode: "ai_message", prompt_hint: "Retomar" },
      },
      {
        id: "end",
        type: "end",
        label: "Fim",
        position: { x: 0, y: 1 },
        config: { outcome: "converted" },
      },
    ],
    edges: [
      { id: "edge", source: "send", target: "end", priority: 0, condition: { type: "always" } },
    ],
  };
  const version = (
    await pool.query(
      "insert into followup_flow_versions(organization_id,graph) values($1,$2) returning id",
      [org, graph],
    )
  ).rows[0].id;
  const pointer = (
    await pool.query(
      "insert into followup_flow_pointers(organization_id,name,status,active_version_id) values($1,'Fluxo','active',$2) returning id",
      [org, version],
    )
  ).rows[0].id;
  const enr = (
    await pool.query(
      "insert into followup_enrollments(organization_id,contact_id,pointer_id,version_id,current_node_id,status,steps_taken,conversation_id,service_boundary) values($1,$2,$3,$4,'send','active',1,$5,$6) returning id",
      [org, contact, pointer, version, boundary.conversation_id, boundary],
    )
  ).rows[0].id;
  await pool.query(
    "insert into followup_enrollment_events(organization_id,enrollment_id,node_id,event_type,idempotency_key) values($1,$2,'send','turn_enqueued','send:0')",
    [org, enr],
  );
  const job = (
    await pool.query(
      "insert into job_queue(organization_id,contact_id,kind,payload) values($1,$2,'followup_turn',$3) returning id",
      [
        org,
        contact,
        {
          service_boundary: boundary,
          followup_enrollment_id: enr,
          node_id: "send",
          source_step_key: "send:0",
        },
      ],
    )
  ).rows[0].id;
  return { org, contact, enr, job };
}
it("reaper e reclaim do mesmo worker não reautorizam transporte/callback/settle antigos", async () => {
  const f = await fixture();
  const claim = async (old: boolean) =>
    claimOfJob(
      (
        await pool.query(
          "update job_queue set status='running',locked_by='mesmo-worker',locked_at=clock_timestamp()-($2::int*interval '2 minutes'),attempts=attempts+1 where id=$1 returning locked_by,locked_at::text as claim_acquired_at",
          [f.job, old ? 1 : 0],
        )
      ).rows[0],
    )!;
  const original = await claim(true);
  const context = {
    organizationId: f.org,
    contactId: f.contact,
    enrollmentId: f.enr,
    nodeId: "send",
    jobId: f.job,
    jobClaim: original,
  };
  await assertAgendaEffectPg(pool, context);
  await reapExpiredJobs(pool, { visibilityTimeoutMs: 60000 });
  await expect(assertAgendaEffectPg(pool, context)).rejects.toBeInstanceOf(
    StaleServiceBoundaryError,
  );
  const current = await claim(false);
  expect(current.worker_id).toBe(original.worker_id);
  expect(current.acquired_at).not.toBe(original.acquired_at);
  const transport = vi.fn();
  await expect(
    (async () => {
      await assertAgendaEffectPg(pool, context);
      transport();
    })(),
  ).rejects.toBeInstanceOf(StaleServiceBoundaryError);
  expect(transport).not.toHaveBeenCalled();
  await expect(
    completeTurnForEnrollment(
      createPgAdminClient(pool),
      f.org,
      f.enr,
      "send",
      { kind: "sent" },
      undefined,
      f.job,
      original,
    ),
  ).rejects.toBeInstanceOf(StaleServiceBoundaryError);
  // A RPC atômica também recusa, mesmo se o caller tiver lido a revisão NOVA.
  const revision = (
    await pool.query("select revision from followup_enrollments where id=$1", [f.enr])
  ).rows[0].revision;
  await expect(
    pool.query("select fn_followup_apply_step($1,$2,$3,$4,$5)", [
      f.org,
      f.enr,
      revision,
      { current_node_id: "end" },
      {
        job_id: f.job,
        job_claim: original,
        node_id: "send",
        event_type: "action_sent",
        idempotency_key: "send:1",
      },
    ]),
  ).rejects.toMatchObject({ code: "40001" });
  expect(
    (
      await pool.query(
        "select fn_followup_inline_settle($1,$2,'mesmo-worker',true,null,null,false,$3) ok",
        [f.org, f.job, original.acquired_at],
      )
    ).rows[0].ok,
  ).toBe(false);
  expect(
    await cancelJob(pool, f.job, current.worker_id, "antigo", original.acquired_at),
  ).toBeNull();
  expect(
    await failJob(pool, f.job, current.worker_id, new Error("antigo"), original.acquired_at),
  ).toBeNull();
  expect(
    await rescheduleJob(pool, f.job, current.worker_id, {
      delayMs: 1,
      reason: "antigo",
      acquiredAt: original.acquired_at,
    }),
  ).toBeNull();
  await expect(
    completeJob(pool, f.job, current.worker_id, undefined, original.acquired_at),
  ).rejects.toThrow("lease");
  await assertAgendaEffectPg(pool, { ...context, jobClaim: current });
  transport();
  await completeTurnForEnrollment(
    createPgAdminClient(pool),
    f.org,
    f.enr,
    "send",
    { kind: "sent" },
    undefined,
    f.job,
    current,
  );
  await completeJob(pool, f.job, current.worker_id, undefined, current.acquired_at);
  expect(transport).toHaveBeenCalledOnce();
  expect(
    (
      await pool.query("select current_node_id,steps_taken from followup_enrollments where id=$1", [
        f.enr,
      ])
    ).rows[0],
  ).toEqual({ current_node_id: "end", steps_taken: 2 });
  expect(
    (
      await pool.query(
        "select count(*)::int n from followup_enrollment_events where enrollment_id=$1 and event_type='action_sent'",
        [f.enr],
      )
    ).rows[0].n,
  ).toBe(1);
});
it("aquisição com microssegundos exige valor completo e ACL é service-only", async () => {
  const f = await fixture();
  const row = (
    await pool.query(
      "update job_queue set status='running',locked_by='precision',locked_at='2026-09-06T12:00:00.123456Z' where id=$1 returning locked_by,locked_at::text as claim_acquired_at",
      [f.job],
    )
  ).rows[0];
  const c = claimOfJob(row)!;
  const current = async (value: string) =>
    (
      await pool.query("select fn_followup_claim_current($1,$2,$3,$4) ok", [
        f.org,
        f.job,
        c.worker_id,
        value,
      ])
    ).rows[0].ok;
  expect(await current(c.acquired_at)).toBe(true);
  expect(await current(new Date(c.acquired_at).toISOString())).toBe(false);
  expect(
    (
      await pool.query(
        "select has_function_privilege('authenticated','fn_followup_claim_current(uuid,uuid,text,timestamptz)','EXECUTE') ok",
      )
    ).rows[0].ok,
  ).toBe(false);
  expect(
    (
      await pool.query("select fn_followup_inline_settle($1,$2,'precision',true) ok", [
        f.org,
        f.job,
      ])
    ).rows[0].ok,
  ).toBe(false);
  await pool.query("update job_queue set status='done',locked_by=null,locked_at=null where id=$1", [
    f.job,
  ]);
});
it("recibo aceito sobrevive à falha do callback e nova instância não repete transporte", async () => {
  const f = await fixture();
  const input = { tenantId: f.org, leadId: f.contact, jobId: f.job, seq: 1, body: "Retomar" };
  const send = vi.fn(async (key: string, id: string) => {
    await pool.query(
      "insert into messages(id,organization_id,contact_id,conversation_id,channel_session_id,direction,type,status,body,metadata) select $1,$2,$3,conversation_id,(select channel_session_id from conversations where id=conversation_id),'outbound','text','sent','Retomar',$4 from followup_enrollments where id=$5",
      [id, f.org, f.contact, { idempotency_key: key }, f.enr],
    );
    return { id, status: "sent" };
  });
  expect((await sendWithLedger(pgSendLedger(pool), input, send)).kind).toBe("sent");
  const failedCallback = vi.fn(async () => {
    throw new Error("callback connection lost");
  });
  await expect(failedCallback()).rejects.toThrow("callback connection lost");
  expect((await sendWithLedger(pgSendLedger(pool), input, send)).kind).toBe("already_sent");
  expect(send).toHaveBeenCalledOnce();
});
