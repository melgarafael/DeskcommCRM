import pg from "pg";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCaseTaskDeliveryHandler } from "@/lib/agent-engine/agent/case-task-delivery";
import {
  applyCaseTaskAction,
  openPaymentTask,
  readCaseTask,
} from "@/lib/agent-engine/agent/case-task";
import { getCaseAwaitingLead, provideCaseUpdate } from "@/lib/agent-engine/agent/human-cases";
import { pgSendLedger, sendWithLedger } from "@/lib/agent-engine/edge/crm/send-ledger";
import { completeJob, type JobRow } from "@/lib/agent-engine/queue/queue";
import type { InboundTurnDeps } from "@/lib/agent-engine/agent/inbound-turn";
import type { ChannelSendInput, ChannelSendResult } from "@/lib/agent-engine/channel-adapter";
import { assertAgendaEffectPg } from "@/lib/agenda/efeito";

// Only the external transport is fake. PostgreSQL, boundaries, before-send,
// pacing, ledger, exact-body approval and task transitions are exercised.
if (!process.env.TEST_DB_CONTAINER) throw new Error("Use pnpm test:db for this invariant.");
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 6,
});
const org = randomUUID();
const actor = randomUUID();
const session = randomUUID();
const pipeline = randomUUID();
const stage = randomUUID();
let contact: string;
let conversation: string;
let caseId: string;
let physicalSends: number;
let mode: "sent" | "queued" | "failed" | "accepted_without_response";
const worker = "case-task-delivery-invariant";
const officialText =
  "Dados oficiais revisados pela equipe:\nChave de teste: chave-sintetica\nConfira o destinatário antes de transferir.";

beforeAll(async () => {
  await pool.query("insert into auth.users(id,email) values($1,$2)", [
    actor,
    `${actor}@invariant.test`,
  ]);
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Prova de entrega','Prova de entrega')",
    [org],
  );
  await pool.query(
    "insert into user_organizations(user_id,organization_id,role,accepted_at) values($1,$2,'agent',now())",
    [actor, org],
  );
  await pool.query(
    "insert into channel_sessions(id,organization_id,waha_session_name,status,webhook_secret_encrypted) values($1::uuid,$2,$1::text,'WORKING','\\x00'::bytea)",
    [session, org],
  );
  await pool.query(
    `insert into channel_knobs(organization_id,channel_session_id,throttle_ms,jitter_max_ms,window_start_hour,window_end_hour,resposta_start_hour,resposta_end_hour,allow_sunday,warmup_daily_caps)
    values($1,$2,0,0,0,24,0,24,true,'[{"minAgeDays":0,"cap":null}]'::jsonb)`,
    [org, session],
  );
  await pool.query(
    "insert into crm_pipelines(id,organization_id,name,slug) values($1::uuid,$2,'Compras de prova',$1::text)",
    [pipeline, org],
  );
  await pool.query(
    "insert into crm_stages(id,organization_id,pipeline_id,name,slug,position) values($1,$2,$3,'Pagamento','pagamento',1)",
    [stage, org, pipeline],
  );
});

beforeEach(async () => {
  await pool.query("delete from job_queue where organization_id=$1", [org]);
  await pool.query("delete from outbound_copies where organization_id=$1", [org]);
  await pool.query("delete from pacing_ledger where organization_id=$1", [org]);
  contact = randomUUID();
  conversation = randomUUID();
  await pool.query(
    "insert into contacts(id,organization_id,name,source) values($1,$2,'Cliente sintética','manual')",
    [contact, org],
  );
  await pool.query(
    "insert into conversations(id,organization_id,contact_id,channel_session_id,status,is_group,last_inbound_at) values($1,$2,$3,$4,'ai_handling',false,now())",
    [conversation, org, contact, session],
  );
  await pool.query(
    "insert into crm_leads(organization_id,pipeline_id,stage_id,contact_id,title) values($1,$2,$3,$4,'Compra de prova')",
    [org, pipeline, stage, contact],
  );
  const { rows } = await pool.query<{ boundary: Record<string, unknown> }>(
    "select fn_service_begin($1,$2,$3) boundary",
    [org, contact, session],
  );
  caseId = await openPaymentTask(
    pool,
    { tenantId: org, conversationId: conversation },
    {
      task_kind: "payment_details",
      title: "Dados oficiais",
      summary: "Cliente escolheu Pix",
      blocker: "Revisar os dados",
      contextSnapshot: { service_boundary: rows[0]!.boundary },
    },
  );
  await applyCaseTaskAction(pool, org, caseId, actor, {
    action: "assume",
    expected_revision: (await read())!.revision,
  });
  physicalSends = 0;
  mode = "sent";
});
afterAll(async () => {
  await pool.end();
});
const read = () => readCaseTask(pool, org, caseId);

async function approve(
  action: "details_release" | "payment_confirmed" | "payment_not_found" = "details_release",
  text = officialText,
) {
  if (action !== "details_release") {
    const snapshot = (await read())!.context_snapshot;
    await openPaymentTask(
      pool,
      { tenantId: org, conversationId: conversation },
      {
        task_kind: "payment_review",
        title: "Conferir pagamento",
        summary: "Cliente informou pagamento",
        blocker: "Conferência da equipe",
        contextSnapshot: snapshot ?? {},
      },
    );
  }
  return applyCaseTaskAction(pool, org, caseId, actor, {
    action,
    expected_revision: (await read())!.revision,
    approved_text: text,
    ...(action === "details_release" ? { payment_method: "pix" as const } : {}),
    ...(action === "payment_not_found"
      ? { note: "Informe o horário aproximado da transferência" }
      : {}),
  });
}

async function claim(id: string): Promise<JobRow> {
  // Database-generated acquisition; no fabricated timestamps or JobClaim.
  const { rows } = await pool.query<JobRow>(
    `update job_queue set status='running',locked_by=$3,locked_at=clock_timestamp(),attempts=attempts+1
    where organization_id=$1 and id=$2 and status='pending' returning *,locked_at::text claim_acquired_at`,
    [org, id, worker],
  );
  if (!rows[0]) throw new Error("job_not_claimable");
  return rows[0];
}

async function fakeTransport(input: ChannelSendInput): Promise<ChannelSendResult> {
  const outcome = await sendWithLedger(pgSendLedger(pool), input, async (key, messageId) => {
    physicalSends += 1;
    const status = mode === "accepted_without_response" ? "sent" : mode;
    await pool.query(
      `insert into messages(id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,sent_via,body,metadata)
      values($1,$2,$3,$4,$5,'text','outbound',$6,'ai',$7,jsonb_build_object('idempotency_key',$8::text))
      on conflict(id) do update set status=excluded.status`,
      [messageId, org, conversation, session, contact, status, input.body, key],
    );
    return { id: messageId, status };
  });
  if (mode === "accepted_without_response")
    return { kind: "unavailable", reason: "transport_response_lost" };
  if (outcome.kind === "blocked") return outcome;
  return {
    kind: outcome.kind,
    idempotencyKey: outcome.idempotencyKey,
    messageId: outcome.crmMessageId,
  } as ChannelSendResult;
}

const handler = createCaseTaskDeliveryHandler({
  // This client is never called: the external transport above owns the seam.
  crmCfg: { supabase: createClient("http://127.0.0.1:54321", "invariant-transport-unused") },
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  sleep: async () => {},
  knobs: { queuedRetryDelayMs: 5000 } as InboundTurnDeps["knobs"],
  channel: () => ({ send: fakeTransport }),
});

describe("entrega de tarefa usa aprovação literal, guarda real e recibo durável", () => {
  it("abrir conferência financeira encerra só a retomada da compra mesmo se o aviso falhar", async () => {
    const details = await approve();
    const detailsJob = await claim(details.delivery_job_id!);
    await handler(detailsJob, pool);
    await completeJob(pool, detailsJob.id, worker, undefined, detailsJob.claim_acquired_at!);
    const detailsCase = caseId;
    const purchaseId = (await read())!.lead_id;
    const version = randomUUID();
    const pointer = randomUUID();
    const otherPointer = randomUUID();
    await pool.query(
      "insert into followup_flow_versions(id,organization_id,graph) values($1,$2,$3)",
      [version, org, { nodes: [], edges: [] }],
    );
    for (const id of [pointer, otherPointer])
      await pool.query(
        "insert into followup_flow_pointers(id,organization_id,name,status,active_version_id) values($1::uuid,$2,'Retomada sintética ' || $1::text,'active',$3)",
        [id, org, version],
      );
    const otherContact = randomUUID();
    const otherConversation = randomUUID();
    await pool.query(
      "insert into contacts(id,organization_id,name,source) values($1,$2,'Outra cliente sintética','manual')",
      [otherContact, org],
    );
    await pool.query(
      "insert into conversations(id,organization_id,contact_id,channel_session_id,status,is_group) values($1,$2,$3,$4,'ai_handling',false)",
      [otherConversation, org, otherContact, session],
    );
    const enrolled = async (
      id: string,
      enrolledContact = contact,
      enrolledConversation = conversation,
    ) => {
      const { rows } = await pool.query<{ id: string; revision: number }>(
        `insert into followup_enrollments(organization_id,pointer_id,version_id,contact_id,conversation_id,current_node_id,status)
         values($1,$2,$3,$4,$5,'action','active') returning id,revision`,
        [org, id, version, enrolledContact, enrolledConversation],
      );
      return rows[0]!;
    };
    const reminder = await enrolled(pointer);
    const unrelated = await enrolled(otherPointer, otherContact, otherConversation);
    await pool.query(
      "update agent_cases set task_payload=task_payload || jsonb_build_object('post_delivery_enrollment_id',$3::text) where organization_id=$1 and id=$2",
      [org, detailsCase, reminder.id],
    );
    const step = `action:${reminder.revision}`;
    await pool.query(
      "insert into followup_enrollment_events(organization_id,enrollment_id,node_id,event_type,idempotency_key) values($1,$2,'action','turn_enqueued',$3)",
      [org, reminder.id, step],
    );
    const waitingJob = randomUUID();
    await pool.query(
      "insert into job_queue(id,organization_id,contact_id,kind,payload) values($1,$2,$3,'followup_turn',$4)",
      [
        waitingJob,
        org,
        contact,
        { followup_enrollment_id: reminder.id, node_id: "action", source_step_key: step },
      ],
    );
    const claimed = await claim(waitingJob);
    const effect = {
      organizationId: org,
      contactId: contact,
      enrollmentId: reminder.id,
      nodeId: "action",
      jobId: waitingJob,
      jobClaim: { worker_id: worker, acquired_at: claimed.claim_acquired_at! },
    };
    await expect(assertAgendaEffectPg(pool, effect)).resolves.toBeUndefined();
    caseId = await openPaymentTask(
      pool,
      { tenantId: org, conversationId: conversation },
      {
        task_kind: "payment_review",
        title: "Conferir",
        summary: "Cliente pagou",
        blocker: "Conferir recebimento",
        contextSnapshot: (await readCaseTask(pool, org, detailsCase))!.context_snapshot ?? {},
      },
    );
    const statesAtReview = (
      await pool.query(
        "select id,status,cancel_reason from followup_enrollments where organization_id=$1 and id=any($2::uuid[])",
        [org, [reminder.id, unrelated.id]],
      )
    ).rows;
    expect(statesAtReview.find((row) => row.id === reminder.id)).toMatchObject({
      status: "cancelled",
      cancel_reason: "payment_review_opened",
    });
    expect(statesAtReview.find((row) => row.id === unrelated.id)).toMatchObject({
      status: "active",
    });
    await expect(assertAgendaEffectPg(pool, effect)).rejects.toThrow();
    await applyCaseTaskAction(pool, org, caseId, actor, {
      action: "assume",
      expected_revision: (await read())!.revision,
    });
    const confirmed = await approve(
      "payment_confirmed",
      "Pagamento recebido e confirmado pela equipe.",
    );
    const states = (
      await pool.query(
        "select id,status,cancel_reason from followup_enrollments where organization_id=$1 and id=any($2::uuid[])",
        [org, [reminder.id, unrelated.id]],
      )
    ).rows;
    expect(states.find((row) => row.id === reminder.id)).toMatchObject({
      status: "cancelled",
      cancel_reason: "payment_review_opened",
    });
    expect(states.find((row) => row.id === unrelated.id)).toMatchObject({ status: "active" });
    await expect(assertAgendaEffectPg(pool, effect)).rejects.toThrow();
    await completeJob(pool, claimed.id, worker, undefined, claimed.claim_acquired_at!);
    mode = "failed";
    await handler(await claim(confirmed.delivery_job_id!), pool);
    expect((await read())!.task_state).toBe("send_failed");
    expect(
      (
        await pool.query("select status from crm_leads where organization_id=$1 and id=$2", [
          org,
          purchaseId,
        ])
      ).rows[0].status,
    ).toBe("open");
    expect(
      (
        await pool.query(
          "select status from followup_enrollments where organization_id=$1 and id=$2",
          [org, reminder.id],
        )
      ).rows[0].status,
    ).toBe("cancelled");
  });
  it("somente o recibo de envio conclui dados e preserva o texto exato", async () => {
    const decision = await approve();
    expect((await read())!.task_state).toBe("awaiting_send");
    await handler(await claim(decision.delivery_job_id!), pool);
    expect(physicalSends).toBe(1);
    expect((await read())!).toMatchObject({ task_state: "completed", status: "resolved" });
    const { rows } = await pool.query(
      "select body,status from messages where organization_id=$1 and contact_id=$2",
      [org, contact],
    );
    expect(rows).toEqual([{ body: officialText, status: "sent" }]);
    expect(
      (
        await pool.query("select status from send_ledger where organization_id=$1 and job_id=$2", [
          org,
          decision.delivery_job_id,
        ])
      ).rows[0].status,
    ).toBe("accepted");
    expect(
      (
        await pool.query(
          "select count(*)::int n from before_send_traces where organization_id=$1 and job_id=$2",
          [org, decision.delivery_job_id],
        )
      ).rows[0].n,
    ).toBeGreaterThan(0);
  });

  it("queued mantém a tarefa aberta e reagenda sem consumir tentativas", async () => {
    mode = "queued";
    const decision = await approve();
    await handler(await claim(decision.delivery_job_id!), pool);
    expect((await read())!).toMatchObject({
      task_state: "awaiting_send",
      status: "awaiting_human",
    });
    const queued = (
      await pool.query("select status,attempts from job_queue where id=$1", [
        decision.delivery_job_id,
      ])
    ).rows[0];
    expect(queued).toMatchObject({ status: "pending", attempts: 0 });
    mode = "sent";
    await handler(await claim(decision.delivery_job_id!), pool);
    expect((await read())!.task_state).toBe("completed");
    expect(
      (
        await pool.query(
          "select count(*)::int n from messages where organization_id=$1 and contact_id=$2",
          [org, contact],
        )
      ).rows[0].n,
    ).toBe(1);
  });

  it("falha de comunicar pagamento não desfaz a decisão e retry usa a mesma intenção", async () => {
    mode = "failed";
    const decision = await approve(
      "payment_confirmed",
      "A equipe confirmou o recebimento da sua compra. Obrigada!",
    );
    const job = await claim(decision.delivery_job_id!);
    await handler(job, pool);
    const failed = (await read())!;
    expect(failed.task_state).toBe("send_failed");
    expect(failed.decision_event_id).toBe(decision.decision_event_id);
    expect(failed.task_payload.decision).toBe("payment_confirmed");
    expect(failed.wait_generation).toBe(decision.wait_generation + 1);
    await completeJob(pool, job.id, worker, undefined, job.claim_acquired_at);
    const retry = await applyCaseTaskAction(pool, org, caseId, actor, {
      action: "retry_send",
      expected_revision: failed.revision,
    });
    expect(retry.delivery_job_id).toBe(job.id);
    mode = "sent";
    await handler(await claim(job.id), pool);
    expect((await read())!).toMatchObject({
      status: "resolved",
      task_state: "completed",
      decision_event_id: decision.decision_event_id,
    });
  });

  it("resposta de transporte perdida reconcilia aceitação sem outra mensagem", async () => {
    mode = "accepted_without_response";
    const decision = await approve();
    await handler(await claim(decision.delivery_job_id!), pool);
    expect(physicalSends).toBe(1);
    expect((await read())!.task_state).toBe("completed");
  });

  it("replay com ledger aceito não chama o canal novamente", async () => {
    const decision = await approve();
    const job = await claim(decision.delivery_job_id!);
    await fakeTransport({
      tenantId: org,
      leadId: contact,
      jobId: job.id,
      seq: 1,
      conversationId: conversation,
      body: officialText,
    });
    expect(physicalSends).toBe(1);
    await handler(job, pool);
    expect(physicalSends).toBe(1);
    expect((await read())!.task_state).toBe("completed");
  });

  it("comprovante anterior ao envio invalida a tarefa de dados sem enviar", async () => {
    const decision = await approve();
    const job = await claim(decision.delivery_job_id!);
    await openPaymentTask(
      pool,
      { tenantId: org, conversationId: conversation },
      {
        task_kind: "payment_review",
        title: "Conferência",
        summary: "Cliente enviou comprovante",
        blocker: "Conferir recebimento",
      },
    );
    await handler(job, pool);
    expect(physicalSends).toBe(0);
    expect((await read())!).toMatchObject({
      task_kind: "payment_review",
      task_state: "awaiting_human",
    });
  });

  it("opt-out veta o envio pela guarda real e deixa a decisão visível", async () => {
    const decision = await approve();
    await pool.query("update contacts set is_blocked=true where organization_id=$1 and id=$2", [
      org,
      contact,
    ]);
    await handler(await claim(decision.delivery_job_id!), pool);
    expect(physicalSends).toBe(0);
    expect((await read())!).toMatchObject({
      task_state: "send_failed",
      decision_event_id: decision.decision_event_id,
    });
  });

  it("pedido de informação alimenta Bia e resposta da cliente inicia nova espera", async () => {
    const decision = await approve(
      "payment_not_found",
      "Pode me dizer o horário aproximado da transferência?",
    );
    await handler(await claim(decision.delivery_job_id!), pool);
    const waiting = (await read())!;
    expect(waiting.task_state).toBe("awaiting_lead");
    expect(await getCaseAwaitingLead(pool, org, conversation)).toMatchObject({
      id: caseId,
      ask: "Informe o horário aproximado da transferência",
    });
    expect(
      await provideCaseUpdate(
        pool,
        { tenantId: org, conversationId: randomUUID() },
        { caseId, info: "Informação de outra conversa" },
      ),
    ).toMatchObject({ ok: false });
    expect((await read())!.wait_generation).toBe(waiting.wait_generation);
    expect((await read())!.task_state).toBe("awaiting_lead");
    expect(
      await provideCaseUpdate(
        pool,
        { tenantId: org, conversationId: conversation },
        { caseId, info: "Transferência foi pela manhã" },
      ),
    ).toEqual({ ok: true });
    const next = (await read())!;
    expect(next.task_state).toBe("awaiting_human");
    expect(next.wait_generation).toBe(waiting.wait_generation + 1);
  });
});
