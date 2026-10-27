import type { Pool, QueryResultRow } from "pg";
import { assertAgentOperationPg } from "@/lib/ai/agents/operation";
import { requireCurrentAutonomousTurn, setExecutionAgentOperation } from "@/lib/atendimento/fronteira-server";

import type { ChannelAdapter } from "@/lib/agent-engine/channel-adapter";
import { applySendOutcome } from "@/lib/agent-engine/edge/crm/send-message";
import type { reconcileAcceptedSend } from "@/lib/agent-engine/edge/crm/send-ledger";
import type { runBeforeSend } from "@/lib/agent-engine/guardrails/before-send";
import { deriveLgpdFromContact } from "@/lib/agent-engine/guardrails/lgpd/legal-basis";
import { isLeadInHandoff } from "@/lib/agent-engine/agent/human-handoff";
import { loadConversationAgentConfig } from "@/lib/agent-engine/agent/agent-config";
import { respostaFicouObsoleta } from "@/lib/agent-engine/agent/turno-ja-respondido";
import type { Logger } from "@/lib/agent-engine/obs/logger";
import { claimOfJob } from "@/lib/agent-engine/queue/claim";
import { cancelJob, rescheduleJob, type JobRow } from "@/lib/agent-engine/queue/queue";
import {
  executeCatalogPresentationSerial,
  type CatalogPresentationExecutionResult,
} from "@/lib/catalogo/executor-de-apresentacao";
import {
  materializeCatalogPresentationSnapshotMedia,
  type MaterializedCatalogPresentation,
} from "@/lib/catalogo/materializacao-de-apresentacao";
import {
  readCatalogPresentationSnapshot,
} from "@/lib/catalogo/snapshot-de-apresentacao";

interface ContactLgpdRow extends QueryResultRow {
  source: string | null;
  consent: Record<string, unknown> | null;
  is_anonymized: boolean;
}

export interface CatalogPresentationResumeDeps {
  channel: ChannelAdapter;
  log: Logger;
  maxSendsPerTurn: number;
  queuedRetryDelayMs: number;
  respostaObsoletaTetoMs: number;
  disclosureMode?: "inject" | "veto";
  clock?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  contracts?: {
    beforeSend?: typeof runBeforeSend;
    reconcileAcceptedSend?: typeof reconcileAcceptedSend;
    materialize?: typeof materializeCatalogPresentationSnapshotMedia;
    interruptedBeforeFirstItem?: () => Promise<boolean>;
    interruptedBetweenItems?: () => Promise<boolean>;
    agentPaused?: () => Promise<boolean>;
  };
}

export type CatalogPresentationResumeResult =
  { handled: false } | { handled: true; disposition: "completed" | "interrupted" | "settled" };

export class CatalogPresentationResumeError extends Error {
  constructor(code: string) {
    super(code);
    this.name = "CatalogPresentationResumeError";
  }
}

function mediaKey(itemIndex: number, stepIndex: number): string {
  return `${itemIndex}:${stepIndex}`;
}

function materializedMediaByStep(
  materialized: MaterializedCatalogPresentation,
): Map<string, string> {
  const result = new Map<string, string>();
  for (const entry of materialized.payloads) {
    if (entry.materialized_media) {
      result.set(
        mediaKey(entry.payload.item_index, entry.payload.step_index),
        entry.materialized_media.storage_path,
      );
    }
  }
  return result;
}

function failureCode(result: CatalogPresentationExecutionResult): string {
  if (result.status === "not_started") return `catalog_presentation_${result.reason}`;
  if (result.status === "stopped") return `catalog_presentation_${result.reason}`;
  return "catalog_presentation_unknown_failure";
}

/**
 * Retoma um plano ja congelado no job. Este caminho nao resolve agente nem chama
 * modelo: a unica fonte da ordem e do conteudo e o snapshot persistido.
 */
export async function resumePersistedCatalogPresentation(
  pool: Pool,
  job: JobRow,
  ctx: { workerId: string },
  input: { conversationId: string; channelSessionId: string },
  deps: CatalogPresentationResumeDeps,
): Promise<CatalogPresentationResumeResult> {
  const raw = job.catalog_presentation_snapshot;
  if (raw === undefined || raw === null) return { handled: false };
  if (!job.contact_id)
    throw new CatalogPresentationResumeError("catalog_presentation_contact_missing");

  const snapshot = readCatalogPresentationSnapshot(raw, job.organization_id);
  if (!snapshot)
    throw new CatalogPresentationResumeError("catalog_presentation_snapshot_invalid");
  const claim = claimOfJob(job);
  if (!claim) throw new CatalogPresentationResumeError("catalog_presentation_claim_missing");
  await requireCurrentAutonomousTurn(pool, job);
  // Recoloca no escopo interno somente a identidade original protegida.
  // A operação vigente é CONFERIDA, nunca usada para substituir a original.
  setExecutionAgentOperation(snapshot.agent_operation);

  let paused = false;
  const pauseBeforeNextItem = async (): Promise<boolean> => {
    paused = deps.contracts?.agentPaused
      ? await deps.contracts.agentPaused()
      : Boolean(
          (
            await loadConversationAgentConfig(
              pool,
              job.organization_id,
              input.conversationId,
              input.channelSessionId,
            )
          )?.pausedAt,
        );
    return paused;
  };
  const settlePause = async (): Promise<CatalogPresentationResumeResult> => {
    const rescheduled = await rescheduleJob(pool, job.id, ctx.workerId, {
      acquiredAt: claim.acquired_at,
      delayMs: deps.queuedRetryDelayMs,
      reason: "apresentacao do catalogo aguardando agente despausado",
    });
    if (rescheduled === null) {
      throw new CatalogPresentationResumeError("catalog_presentation_job_lease_lost");
    }
    return { handled: true, disposition: "settled" };
  };
  const interrupted = async (): Promise<boolean> => {
    if (await isLeadInHandoff(pool, job.organization_id, job.contact_id!)) return true;
    return respostaFicouObsoleta(
      pool,
      {
        organizationId: job.organization_id,
        conversationId: input.conversationId,
        jobId: job.id,
      },
      deps.respostaObsoletaTetoMs,
    );
  };
  if (
    (await pauseBeforeNextItem()) ||
    (deps.contracts?.interruptedBeforeFirstItem
      ? await deps.contracts.interruptedBeforeFirstItem()
      : await interrupted()) === true
  ) {
    if (paused) return settlePause();
    return { handled: true, disposition: "interrupted" };
  }

  const contact = await pool.query<ContactLgpdRow>(
    `select source, consent, is_anonymized
       from contacts
      where organization_id = $1 and id = $2`,
    [job.organization_id, job.contact_id],
  );
  const contactRow = contact.rows[0];
  if (!contactRow) throw new CatalogPresentationResumeError("catalog_presentation_contact_missing");

  const materialize = deps.contracts?.materialize ?? materializeCatalogPresentationSnapshotMedia;
  await assertAgentOperationPg(pool, snapshot.agent_operation);
  const materialized = await materialize(
    { ok: true, snapshot, reused: true },
    {
      organizationId: job.organization_id,
      conversationId: input.conversationId,
      sendsAlreadyCounted: snapshot.sends_already_counted,
      maxSendsPerTurn: deps.maxSendsPerTurn,
    },
  );
  if (!materialized.ok) {
    throw new CatalogPresentationResumeError(
      `catalog_presentation_materialization_${materialized.error.code}`,
    );
  }
  const media = materializedMediaByStep(materialized.materialized);

  const result = await executeCatalogPresentationSerial(snapshot.plan, {
    channel: deps.channel,
    conversationId: input.conversationId,
    jobClaim: claim,
    sendsAlreadyCounted: snapshot.sends_already_counted,
    maxSendsPerTurn: deps.maxSendsPerTurn,
    materializeMedia: async (payload) => {
      const storagePath = media.get(mediaKey(payload.item_index, payload.step_index));
      if (!storagePath) {
        throw new CatalogPresentationResumeError("catalog_presentation_media_not_materialized");
      }
      return { storagePath };
    },
    interruptedBetweenItems: async () => {
      if (deps.contracts?.interruptedBetweenItems) {
        return deps.contracts.interruptedBetweenItems();
      }
      return interrupted();
    },
    pausedBeforeSend: pauseBeforeNextItem,
    beforeSend: {
      agentOperation: snapshot.agent_operation,
      pool,
      log: deps.log,
      tenantId: job.organization_id,
      leadId: job.contact_id,
      jobId: job.id,
      channelSessionId: input.channelSessionId,
      optedOutThisTurn: false,
      resposta: true,
      crmDailyLimit: null,
      now: deps.clock?.() ?? new Date(),
      lgpd: deriveLgpdFromContact(contactRow, false),
      ...(deps.disclosureMode !== undefined ? { disclosureMode: deps.disclosureMode } : {}),
      ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
    },
    contracts: {
      ...(deps.contracts?.beforeSend !== undefined
        ? { beforeSend: deps.contracts.beforeSend }
        : {}),
      ...(deps.contracts?.reconcileAcceptedSend !== undefined
        ? { reconcileAcceptedSend: deps.contracts.reconcileAcceptedSend }
        : {}),
    },
  });

  if (result.status === "completed") return { handled: true, disposition: "completed" };
  if (result.status === "not_started")
    throw new CatalogPresentationResumeError(failureCode(result));
  if (result.reason === "interrupted") {
    if (paused) return settlePause();
    return { handled: true, disposition: "interrupted" };
  }

  if (result.reason === "queued" || result.reason === "blocked") {
    if (result.outcome.kind !== result.reason) {
      throw new CatalogPresentationResumeError("catalog_presentation_outcome_mismatch");
    }
    const sendOutcome =
      result.outcome.kind === "queued"
        ? {
            kind: "queued" as const,
            idempotencyKey: result.outcome.idempotencyKey,
            crmMessageId: result.outcome.messageId,
          }
        : { kind: "blocked" as const, idempotencyKey: result.outcome.idempotencyKey };
    const disposition = await applySendOutcome(
      pool,
      sendOutcome,
      {
        jobId: job.id,
        workerId: ctx.workerId,
        tenantId: job.organization_id,
        leadId: job.contact_id,
        jobClaim: claim,
      },
      { queuedRetryDelayMs: deps.queuedRetryDelayMs },
    );
    if (disposition.action === "none" || disposition.job === null) {
      throw new CatalogPresentationResumeError("catalog_presentation_job_lease_lost");
    }
    return { handled: true, disposition: "settled" };
  }

  if (result.reason === "vetoed") {
    if (result.next_allowed_at !== undefined) {
      const rescheduled = await rescheduleJob(pool, job.id, ctx.workerId, {
        acquiredAt: claim.acquired_at,
        delayMs: Math.max(
          result.next_allowed_at.getTime() - (deps.clock?.() ?? new Date()).getTime(),
          1_000,
        ),
        reason: `apresentacao do catalogo adiada pelo guardrail ${result.code}`,
      });
      if (rescheduled === null) {
        throw new CatalogPresentationResumeError("catalog_presentation_job_lease_lost");
      }
      return { handled: true, disposition: "settled" };
    }
    if (result.code === "contato_bloqueado") {
      const disposition = await applySendOutcome(
        pool,
        { kind: "blocked", idempotencyKey: "catalog-presentation-guardrail" },
        {
          jobId: job.id,
          workerId: ctx.workerId,
          tenantId: job.organization_id,
          leadId: job.contact_id,
          jobClaim: claim,
        },
        { queuedRetryDelayMs: deps.queuedRetryDelayMs },
      );
      if (disposition.action === "none" || disposition.job === null) {
        throw new CatalogPresentationResumeError("catalog_presentation_job_lease_lost");
      }
      return { handled: true, disposition: "settled" };
    }
    if (["lgpd_anonymized", "lgpd_missing_legal_basis"].includes(result.code)) {
      const cancelled = await cancelJob(
        pool,
        job.id,
        ctx.workerId,
        `apresentacao do catalogo interrompida pelo guardrail ${result.code}`,
        claim.acquired_at,
      );
      if (cancelled === null) {
        throw new CatalogPresentationResumeError("catalog_presentation_job_lease_lost");
      }
      return { handled: true, disposition: "settled" };
    }
  }

  throw new CatalogPresentationResumeError(failureCode(result));
}
