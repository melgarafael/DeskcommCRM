import type pg from "pg";
import { randomUUID } from "node:crypto";
import {
  caseTaskActionSchema,
  CaseTaskConflict,
  type CaseTaskAction,
  type CaseTaskFields,
  type CaseTaskKind,
} from "./case-task-schema";
import { resolveActiveLeadForContact, type LeadCandidate } from "@/lib/leads/active-lead";
import { enqueueJob, type Queryable } from "../queue/queue";
import { currentExecutionBoundary } from "@/lib/atendimento/fronteira-server";

export interface TaskRow extends CaseTaskFields {
  id: string;
  organization_id: string;
  conversation_id: string;
  contact_id: string;
  channel_session_id: string | null;
  status: string;
  agent_id: string | null;
  context_snapshot: Record<string, unknown> | null;
}

export async function readCaseTask(
  db: Queryable,
  org: string,
  id: string,
  lock = false,
): Promise<TaskRow | null> {
  const { rows } = await db.query<TaskRow>(
    `select ac.*, conv.contact_id,conv.channel_session_id,
       u.raw_user_meta_data->>'full_name' assignee_name,l.title lead_title
     from agent_cases ac join conversations conv on conv.id=ac.conversation_id and conv.organization_id=ac.organization_id
     left join auth.users u on u.id=ac.assignee_user_id
     left join crm_leads l on l.id=ac.lead_id and l.organization_id=ac.organization_id
     where ac.organization_id=$1 and ac.id=$2 ${lock ? "for update of ac" : ""}`,
    [org, id],
  );
  const row = rows[0];
  return row
    ? { ...row, revision: Number(row.revision), wait_generation: Number(row.wait_generation) }
    : null;
}

export function taskFields(row: TaskRow): CaseTaskFields {
  return {
    lead_id: row.lead_id,
    lead_title: row.lead_title,
    task_kind: row.task_kind,
    task_state: row.task_state,
    revision: Number(row.revision),
    wait_generation: Number(row.wait_generation),
    wait_started_at: row.wait_started_at,
    assignee_user_id: row.assignee_user_id,
    assignee_name: row.assignee_name,
    task_payload: row.task_payload,
    decision_event_id: row.decision_event_id,
    delivery_job_id: row.delivery_job_id,
  };
}

/** Derive a business identity from tenant/contact facts; never accept model ids. */
export async function resolveTaskLead(
  db: Queryable,
  org: string,
  contact: string,
  pipelineIds?: readonly string[],
): Promise<string> {
  const { rows } = await db.query<LeadCandidate>(
    "select id,organization_id,pipeline_id,status,last_activity_at,created_at from crm_leads where organization_id=$1 and contact_id=$2",
    [org, contact],
  );
  const resolution = resolveActiveLeadForContact(rows);
  if (!resolution.routed)
    throw new CaseTaskConflict(
      "invalid_state",
      "Identifique o negócio atual no funil antes de abrir a tarefa de pagamento.",
    );
  const target = rows.find((row) => row.id === resolution.leadId)!;
  if (pipelineIds && !pipelineIds.includes(target.pipeline_id))
    throw new CaseTaskConflict(
      "forbidden",
      "O negócio atual está fora dos funis permitidos a este assistente.",
    );
  return resolution.leadId;
}

export async function recordTaskEvent(
  db: Queryable,
  org: string,
  id: string,
  actor: string | null,
  body: string,
  metadata: Record<string, unknown>,
): Promise<string> {
  const decision =
    actor &&
    ["details_release", "payment_confirmed", "payment_not_found", "need_information"].includes(
      String(metadata.task_action),
    );
  const asks =
    decision && ["payment_not_found", "need_information"].includes(String(metadata.task_action));
  const { rows } = await db.query<{ id: string }>(
    `insert into agent_case_events(organization_id,case_id,kind,actor_kind,actor_user_id,body,metadata,human_action)
     values($1,$2,$7,$3,$4,$5,$6,$8) returning id`,
    [
      org,
      id,
      actor ? "human" : "system",
      actor,
      body,
      metadata,
      decision ? "human_replied" : "agent_noted",
      asks ? "need_lead_info" : null,
    ],
  );
  return rows[0]!.id;
}

export function validateTaskAction(
  row: TaskRow,
  actor: string,
  action: CaseTaskAction,
  canReassign = false,
): void {
  if (!row.task_kind || ["resolved", "cancelled", "escalated"].includes(row.status))
    throw new CaseTaskConflict(
      "invalid_state",
      "Esta tarefa já foi encerrada ou não é uma tarefa de pagamento.",
    );
  if (row.revision !== action.expected_revision)
    throw new CaseTaskConflict("invalid_state", "A tarefa mudou. Atualize a tela antes de agir.");
  if (action.action === "takeover") {
    if (!canReassign)
      throw new CaseTaskConflict(
        "forbidden",
        "Somente um gestor pode reassumir uma tarefa de outra pessoa.",
      );
    return;
  }
  if (action.action === "assume") {
    if (row.assignee_user_id && row.assignee_user_id !== actor)
      throw new CaseTaskConflict("invalid_state", "Outra pessoa já assumiu esta tarefa.");
    return;
  }
  if (row.assignee_user_id !== actor)
    throw new CaseTaskConflict("forbidden", "Assuma a tarefa antes de registrar uma decisão.");
  if (action.action === "release") return;
  if (action.action === "link_purchase") {
    if (row.lead_id || row.task_state !== "awaiting_human")
      throw new CaseTaskConflict(
        "invalid_state",
        "A compra já foi identificada; o vínculo de uma decisão não pode ser trocado.",
      );
    return;
  }
  if (action.action === "retry_send") {
    if (row.task_state !== "send_failed")
      throw new CaseTaskConflict("invalid_state", "Não há envio com falha para tentar novamente.");
    return;
  }
  if (row.task_state !== "awaiting_human")
    throw new CaseTaskConflict(
      "invalid_state",
      "A tarefa não está aguardando uma decisão da equipe.",
    );
  if (action.action === "details_release" && row.task_kind !== "payment_details")
    throw new CaseTaskConflict(
      "invalid_state",
      "Esta tarefa é de conferência, não de liberação de dados.",
    );
  if (
    ["payment_confirmed", "payment_not_found"].includes(action.action) &&
    row.task_kind !== "payment_review"
  )
    throw new CaseTaskConflict(
      "invalid_state",
      "A confirmação só pode ser registrada na tarefa de conferência.",
    );
  if (!row.lead_id)
    throw new CaseTaskConflict(
      "invalid_state",
      "A tarefa precisa estar vinculada ao negócio desta compra.",
    );
}

/** Row lock + compare revision + event + enqueue are committed together. */
export async function applyCaseTaskAction(
  pool: pg.Pool,
  org: string,
  id: string,
  actor: string,
  raw: CaseTaskAction,
  authority: { canReassign?: boolean } = {},
): Promise<CaseTaskFields> {
  const action = caseTaskActionSchema.parse(raw);
  const db = await pool.connect();
  try {
    await db.query("begin");
    if (action.action === "payment_confirmed") {
      const { rows: scope } = await db.query<{ conversation_id: string }>(
        "select conversation_id from agent_cases where organization_id=$1 and id=$2",
        [org, id],
      );
      if (!scope[0]) throw new CaseTaskConflict("not_found", "Caso não encontrado.");
      // Same order as post-delivery enrollment: conversation serialization,
      // then case lock. A late consumer either precedes this cancellation or
      // sees the committed financial decision and refuses enrollment.
      await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
        `${org}:case:${scope[0].conversation_id}`,
      ]);
    }
    const row = await readCaseTask(db, org, id, true);
    if (!row) throw new CaseTaskConflict("not_found", "Caso não encontrado.");
    validateTaskAction(row, actor, action, authority.canReassign);
    if (action.action === "assume" || action.action === "release" || action.action === "takeover") {
      await db.query(
        "update agent_cases set assignee_user_id=$3,revision=revision+1 where organization_id=$1 and id=$2",
        [org, id, action.action === "release" ? null : actor],
      );
      await recordTaskEvent(
        db,
        org,
        id,
        actor,
        action.action === "release" ? "A tarefa voltou para a equipe." : "A tarefa foi assumida.",
        { task_action: action.action, previous_assignee: row.assignee_user_id },
      );
    } else if (action.action === "link_purchase") {
      const { rows } = await db.query<{ id: string }>(
        "select id from crm_leads where organization_id=$1 and id=$2 and contact_id=$3 and status='open'",
        [org, action.lead_id, row.contact_id],
      );
      if (!rows[0])
        throw new CaseTaskConflict(
          "invalid_state",
          "O negócio escolhido não é uma compra aberta deste contato.",
        );
      await db.query(
        "update agent_cases set lead_id=$3,revision=revision+1 where organization_id=$1 and id=$2",
        [org, id, action.lead_id],
      );
      await recordTaskEvent(db, org, id, actor, "A equipe identificou a compra desta tarefa.", {
        task_action: "link_purchase",
        lead_id: action.lead_id,
      });
    } else {
      const payload =
        action.action === "retry_send"
          ? row.task_payload
          : {
              approved_text: action.approved_text!,
              payment_method: action.payment_method ?? row.task_payload.payment_method,
              next_step: action.note ?? null,
              decision: action.action,
              post_delivery_pointer_id: action.post_delivery_pointer_id ?? null,
            };
      if (typeof payload.approved_text !== "string" || !payload.approved_text.trim())
        throw new CaseTaskConflict("invalid_state", "O envio precisa de um texto aprovado.");
      const event =
        action.action === "retry_send"
          ? row.decision_event_id
          : await recordTaskEvent(
              db,
              org,
              id,
              actor,
              action.note ?? "A equipe registrou a decisão.",
              {
                task_action: action.action,
                result: action.action,
                lead_id: row.lead_id,
                conversation_id: row.conversation_id,
              },
            );
      let jobId: string;
      if (action.action === "retry_send") {
        // Preserve intention and ledger: a late receipt of the old attempt must
        // be reconciled rather than becoming a second message to the customer.
        if (!row.delivery_job_id)
          throw new CaseTaskConflict(
            "invalid_state",
            "A intenção original do envio não foi encontrada.",
          );
        const { rows } = await db.query<{ id: string }>(
          `update job_queue set status='pending',attempts=0,locked_by=null,locked_at=null,run_after=now(),last_error=null,
          payload=payload || jsonb_build_object('task_generation',$3::bigint)
          where organization_id=$1 and id=$2 and status in ('done','dead','failed') returning id`,
          [org, row.delivery_job_id, row.wait_generation],
        );
        if (!rows[0])
          throw new CaseTaskConflict(
            "invalid_state",
            "O envio já está sendo processado. Atualize a tarefa.",
          );
        jobId = rows[0].id;
      } else {
        const { job } = await enqueueJob(db, org, {
          kind: "case_reply_turn",
          leadId: row.contact_id,
          payload: {
            case_id: id,
            action: "task_delivery",
            task_generation: row.wait_generation,
            decision_event_id: event,
            service_boundary: row.context_snapshot?.service_boundary,
          },
        });
        jobId = job.id;
      }
      // The financial result is in the decision event, independently of delivery.
      await db.query(
        `update agent_cases set task_state=$3,task_payload=$4,decision_event_id=$5,delivery_job_id=$6,
        revision=revision+1 where organization_id=$1 and id=$2`,
        [org, id, "awaiting_send", payload, event, jobId],
      );
      if (action.action === "payment_confirmed") {
        // The human financial decision stops only the payment reminder whose
        // durable receipt belongs to this purchase. Message delivery may fail
        // without making that purchase unpaid again.
        await db.query(
          `with stopped as (
            update followup_enrollments e set status='cancelled',cancel_reason='payment_confirmed',
              completed_at=now(),updated_at=now(),next_eval_at=null,claimed_until=null,revision=e.revision+1
            where e.organization_id=$1 and e.contact_id=$3 and e.conversation_id=$4
              and e.status in ('active','waiting_reply') and exists (
                select 1 from agent_cases details where details.organization_id=$1
                  and details.lead_id=$2 and details.conversation_id=$4
                  and details.task_kind='payment_details'
                  and details.task_payload->>'post_delivery_enrollment_id'=e.id::text
              ) returning e.id,e.current_node_id
          ) insert into followup_enrollment_events
            (organization_id,enrollment_id,node_id,event_type,payload,idempotency_key)
          select $1,id,current_node_id,'cancelled',jsonb_build_object('reason','payment_confirmed','decision_event_id',$5::uuid),
            'payment-confirmed:' || $5::text from stopped on conflict do nothing`,
          [org, row.lead_id, row.contact_id, row.conversation_id, event],
        );
      }
    }
    const current = await readCaseTask(db, org, id);
    await db.query("commit");
    return taskFields(current!);
  } catch (error) {
    await db.query("rollback");
    throw error;
  } finally {
    db.release();
  }
}

/** One conversation case continues when the customer reports a payment. */
export async function openPaymentTask(
  pool: pg.Pool,
  ids: {
    tenantId: string;
    conversationId: string;
    agentId?: string | null;
    pipelineIds?: readonly string[];
  },
  input: {
    task_kind: CaseTaskKind;
    title: string;
    summary: string;
    blocker: string;
    contextSnapshot?: Record<string, unknown>;
  },
): Promise<string> {
  const db = await pool.connect();
  try {
    await db.query("begin");
    // Covers concurrent callers, including callers outside the agent job lane.
    await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${ids.tenantId}:case:${ids.conversationId}`,
    ]);
    const { rows: conv } = await db.query<{ contact_id: string }>(
      "select contact_id from conversations where organization_id=$1 and id=$2 and is_group=false",
      [ids.tenantId, ids.conversationId],
    );
    if (!conv[0]?.contact_id) throw new CaseTaskConflict("not_found", "Conversa não encontrada.");
    let lead: string | null = null;
    try {
      lead = await resolveTaskLead(db, ids.tenantId, conv[0].contact_id, ids.pipelineIds);
    } catch (error) {
      if (!(error instanceof CaseTaskConflict) || error.code !== "invalid_state") throw error;
    }
    const { rows: existing } = await db.query<{
      id: string;
      lead_id: string | null;
      task_kind: string | null;
      task_state: string | null;
    }>(
      "select id,lead_id,task_kind,task_state from agent_cases where organization_id=$1 and conversation_id=$2 and status in ('awaiting_human','awaiting_lead') for update",
      [ids.tenantId, ids.conversationId],
    );
    const prior = existing[0];
    if (prior && ((lead && prior.lead_id && prior.lead_id !== lead) || !prior.task_kind))
      throw new CaseTaskConflict(
        "invalid_state",
        "Já existe outra pendência nesta conversa. A equipe precisa resolvê-la antes desta tarefa.",
      );
    const id = prior?.id ?? randomUUID();
    if (prior && prior.task_kind === input.task_kind && prior.task_state !== "awaiting_lead") {
      await recordTaskEvent(db, ids.tenantId, id, null, input.summary, {
        task_action: "customer_update",
      });
    } else if (prior) {
      await db.query(
        `update agent_cases set task_kind=$3,task_state='awaiting_human',status='awaiting_human',wait_started_at=now(),wait_generation=wait_generation+1,
        revision=revision+1,task_payload='{}',decision_event_id=null,delivery_job_id=null where organization_id=$1 and id=$2`,
        [ids.tenantId, id, input.task_kind],
      );
      await recordTaskEvent(db, ids.tenantId, id, null, input.summary, {
        task_action: "new_wait",
        task_kind: input.task_kind,
      });
    } else {
      await db.query(
        `insert into agent_cases(id,organization_id,conversation_id,agent_id,lead_id,title,summary,blocker,kind,task_kind,task_state,wait_started_at,wait_generation,context_snapshot)
        values($1,$2,$3,$4,$5,$6,$7,$8,'financeiro',$9,'awaiting_human',now(),1,$10)`,
        [
          id,
          ids.tenantId,
          ids.conversationId,
          ids.agentId ?? null,
          lead,
          input.title,
          input.summary,
          input.blocker,
          input.task_kind,
          {
            ...input.contextSnapshot,
            service_boundary: currentExecutionBoundary() ?? input.contextSnapshot?.service_boundary,
          },
        ],
      );
      await db.query(
        "insert into agent_case_events(organization_id,case_id,kind,actor_kind) values($1,$2,'opened','agent')",
        [ids.tenantId, id],
      );
    }
    await db.query("commit");
    return id;
  } catch (error) {
    await db.query("rollback");
    throw error;
  } finally {
    db.release();
  }
}
