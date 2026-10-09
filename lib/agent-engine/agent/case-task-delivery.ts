import type pg from "pg";
import { z } from "zod";
import type { JobRow } from "../queue/queue";
import { rescheduleJob } from "../queue/queue";
import { claimOfJob } from "../queue/claim";
import { reconcileAcceptedSend } from "../edge/crm/send-ledger";
import { createRuntimeSendChannel, type RuntimeSendChannel } from "@/lib/channels/runtime";
import { runBeforeSend } from "../guardrails/before-send";
import { deriveLgpdFromContact, type LgpdContactFields } from "../guardrails/lgpd/legal-basis";
import { withServiceJob } from "@/lib/atendimento/fronteira-server";
import type { InboundTurnDeps } from "./inbound-turn";
import { readCaseTask, recordTaskEvent, type TaskRow } from "./case-task";

const payloadSchema = z.object({
  case_id: z.uuid(),
  action: z.literal("task_delivery"),
  task_generation: z.number().int(),
  decision_event_id: z.uuid(),
});

async function settleSent(db: pg.PoolClient, row: TaskRow, job: JobRow) {
  const waiting = ["payment_not_found", "need_information"].includes(
    String(row.task_payload.decision),
  );
  await db.query(
    `update agent_cases set task_state=$3,status=$4,closed_at=case when $4='resolved' then now() else null end,
    revision=revision+1 where organization_id=$1 and id=$2 and delivery_job_id=$5`,
    [
      job.organization_id,
      row.id,
      waiting ? "awaiting_lead" : "completed",
      waiting ? "awaiting_lead" : "resolved",
      job.id,
    ],
  );
  await recordTaskEvent(
    db,
    job.organization_id,
    row.id,
    null,
    "O envio aprovado pela equipe foi confirmado pelo canal.",
    {
      task_action: "delivery_confirmed",
      task_kind: row.task_kind,
      job_id: job.id,
    },
  );
  if (
    row.task_kind === "payment_details" &&
    row.task_payload.decision === "details_release" &&
    typeof row.task_payload.post_delivery_pointer_id === "string"
  ) {
    await db.query(
      `select emit_event('ai.case_task_delivery_confirmed','agent_case',$2,
      jsonb_build_object('case_id',$2::uuid,'task_generation',$3::bigint,'decision_event_id',$4::uuid,'delivery_job_id',$5::uuid,'post_delivery_pointer_id',$6::uuid),'{}'::jsonb,$1)`,
      [
        job.organization_id,
        row.id,
        row.wait_generation,
        row.decision_event_id,
        job.id,
        row.task_payload.post_delivery_pointer_id,
      ],
    );
  }
}

/** Exact approved body, shared guards and ledger; the model cannot rewrite a key/link. */
export function createCaseTaskDeliveryHandler(
  deps: Pick<InboundTurnDeps, "crmCfg" | "log" | "sleep" | "knobs"> & {
    channel?: (db: pg.Pool) => RuntimeSendChannel;
  },
) {
  return async (job: JobRow, pool: pg.Pool) => {
    const payload = payloadSchema.parse(job.payload);
    const claim = claimOfJob(job);
    if (!claim || !job.contact_id) throw new Error("case_task_delivery_missing_claim");
    const db = await pool.connect();
    try {
      await db.query("begin");
      const { rows: owned } = await db.query<{ id: string }>(
        "select id from job_queue where organization_id=$1 and id=$2 and status='running' and locked_by=$3 and locked_at=$4::timestamptz for no key update",
        [job.organization_id, job.id, claim.worker_id, claim.acquired_at],
      );
      if (!owned[0]) {
        await db.query("commit");
        return;
      }
      // The task row remains locked until the irreversible send and its receipt.
      // A simultaneous review/decision cannot invalidate the approval mid-send.
      const row = await readCaseTask(db, job.organization_id, payload.case_id, true);
      if (
        !row ||
        row.delivery_job_id !== job.id ||
        row.decision_event_id !== payload.decision_event_id ||
        row.wait_generation !== payload.task_generation ||
        row.contact_id !== job.contact_id ||
        row.task_state !== "awaiting_send"
      ) {
        await db.query("commit");
        return;
      }
      if (
        await reconcileAcceptedSend(pool, { tenantId: job.organization_id, jobId: job.id, seq: 1 })
      ) {
        await settleSent(db, row, job);
        await db.query("commit");
        return;
      }
      const text = z.string().trim().min(1).max(4000).parse(row.task_payload.approved_text);
      if (!row.channel_session_id) throw new Error("case_task_missing_channel");
      const { rows } = await db.query<LgpdContactFields & { daily_message_limit: number | null }>(
        `select c.source,c.consent,c.is_anonymized,s.daily_message_limit from contacts c
          join channel_sessions s on s.organization_id=c.organization_id and s.id=$3
          where c.organization_id=$1 and c.id=$2`,
        [job.organization_id, job.contact_id, row.channel_session_id],
      );
      if (!rows[0]) throw new Error("case_task_missing_contact");
      const channel =
        deps.channel?.(pool) ??
        createRuntimeSendChannel(pool, { ...deps.crmCfg, agentActorId: row.agent_id ?? undefined });
      const result = await withServiceJob(pool, job, () =>
        runBeforeSend({
          pool,
          log: deps.log,
          tenantId: job.organization_id,
          leadId: job.contact_id!,
          jobId: job.id,
          agentId: row.agent_id ?? undefined,
          channelSessionId: row.channel_session_id!,
          body: text,
          optedOutThisTurn: false,
          crmDailyLimit: rows[0]!.daily_message_limit,
          now: new Date(),
          resposta: true,
          lgpd: deriveLgpdFromContact(rows[0]!, false),
          sleep: deps.sleep,
          send: async (body) => {
            if (body !== text) throw new Error("case_task_body_changed_reapproval_required");
            return channel.send({
              tenantId: job.organization_id,
              leadId: job.contact_id,
              jobId: job.id,
              jobClaim: claim,
              seq: 1,
              conversationId: row.conversation_id,
              body,
            });
          },
        }),
      );
      if (
        result.status !== "vetoed" &&
        (result.outcome.kind === "sent" || result.outcome.kind === "already_sent")
      ) {
        await settleSent(db, row, job);
      } else if (
        (result.status === "vetoed" && result.nextAllowedAt) ||
        (result.status !== "vetoed" && result.outcome.kind === "queued")
      ) {
        const delay =
          result.status === "vetoed" && result.nextAllowedAt
            ? Math.max(1000, result.nextAllowedAt.getTime() - Date.now())
            : deps.knobs.queuedRetryDelayMs;
        await rescheduleJob(db, job.id, claim.worker_id, {
          delayMs: delay,
          reason: "case_task_channel_wait",
          acquiredAt: claim.acquired_at,
        });
      } else if (
        result.status !== "vetoed" &&
        result.outcome.kind === "unavailable" &&
        (await reconcileAcceptedSend(pool, {
          tenantId: job.organization_id,
          jobId: job.id,
          seq: 1,
        }))
      ) {
        await settleSent(db, row, job);
      } else {
        await db.query(
          `update agent_cases set task_state='send_failed',revision=revision+1,wait_generation=wait_generation+1,wait_started_at=now(),
          task_payload=task_payload || jsonb_build_object('delivery_error',$3::text) where organization_id=$1 and id=$2`,
          [
            job.organization_id,
            row.id,
            result.status === "vetoed" ? result.code : result.outcome.kind,
          ],
        );
        await recordTaskEvent(
          db,
          job.organization_id,
          row.id,
          null,
          "O envio não foi confirmado. A decisão permanece registrada; a equipe precisa revisar o envio.",
          { task_action: "delivery_failed" },
        );
      }
      await db.query("commit");
    } catch (error) {
      await db.query("rollback");
      // No new intention: a retry of this job reconciles the same ledger first.
      throw error;
    } finally {
      db.release();
    }
  };
}
