import type { Pool, QueryResultRow } from "pg";
import { assertAgentOperationPg, operacaoDepoisDaPausa } from "@/lib/ai/agents/operation";
import { capacidadesLigadas } from "@/lib/organizacao/capacidades";
import { requireCurrentAutonomousTurn, setExecutionAgentOperation } from "@/lib/atendimento/fronteira-server";

import type { ChannelAdapter } from "@/lib/agent-engine/channel-adapter";
import { applySendOutcome } from "@/lib/agent-engine/edge/crm/send-message";
import { reconcileAcceptedSend } from "@/lib/agent-engine/edge/crm/send-ledger";
import { insertInboxItem } from "@/lib/agent-engine/db/repository";
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
import { prepareCatalogPresentationPayloads } from "@/lib/catalogo/preparo-de-apresentacao";
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
  | { handled: false }
  | { handled: true; disposition: "completed" | "interrupted" | "settled" }
  | {
      handled: true;
      /**
       * Um gate de envio barrou a sequência fixa sem dar hora para tentar de
       * novo (ex.: `mass_identical`, o mesmo texto já foi a outros clientes).
       * O snapshot sai do job e o turno volta ao modelo, que responde com as
       * próprias palavras pelo mesmo gate. `nextSeq` é a seq vetada, ainda livre
       * no send_ledger; as `sent` anteriores já saíram.
       */
      disposition: "vetoed";
      code: string;
      /** O motivo instrutivo do gate (ou da retomada), para o modelo seguir. */
      message: string;
      sent: number;
      nextSeq: number;
    };

/** A mídia do produto foi trocada ou apagada e a cópia da conversa também não existe. */
export const CODIGO_MIDIA_DA_APRESENTACAO_INDISPONIVEL = "catalog_presentation_media_unavailable";

/**
 * O que a ferramenta devolve ao modelo quando a apresentação é vetada. O motivo
 * é o do veto real (o mesmo erro instrutivo que o send_message devolveria),
 * nunca um texto fixo: cada código pede uma resposta diferente.
 */
export function respostaAoVetoDaApresentacao(
  enviadas: number,
  veto: { code: string; message: string },
): { ok: false; code: "catalog_presentation_vetoed"; message: string } {
  const motivo = `Motivo (${veto.code}): ${veto.message}`;
  return {
    ok: false,
    code: "catalog_presentation_vetoed",
    message:
      enviadas === 0
        ? `A apresentação não foi enviada. ${motivo} Siga esse motivo e responda ao cliente usando send_message, com suas palavras.`
        : `A apresentação parou depois de ${enviadas} mensagem(ns) que o cliente já recebeu. ${motivo} Siga esse motivo e complete a resposta usando send_message, com suas palavras, sem repetir o que já foi enviado.`,
  };
}

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

async function apresentacaoLigadaPg(pool: Pool, organizationId: string): Promise<boolean> {
  const { rows } = await pool.query<{ settings: unknown }>(
    "select settings from organizations where id = $1",
    [organizationId],
  );
  return capacidadesLigadas(rows[0]?.settings, []).includes("apresentacao_do_catalogo");
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
  // A operação vigente é CONFERIDA, nunca usada para substituir a original —
  // salvo a revisão, quando o único passo desde o snapshot foi pausar e
  // despausar e a capacidade segue ligada (despausar soma operation_revision).
  let operation = await operacaoDepoisDaPausa(
    pool,
    snapshot.agent_operation,
    snapshot.agent_operation_fingerprint,
  );
  if (operation !== snapshot.agent_operation && !(await apresentacaoLigadaPg(pool, job.organization_id))) {
    operation = snapshot.agent_operation;
  }
  setExecutionAgentOperation(operation);

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
  // Sob o lease: quem perdeu o job não limpa o snapshot de quem o tem agora.
  const clearSnapshot = async (): Promise<void> => {
    const cleared = await pool.query(
      `update job_queue
          set catalog_presentation_snapshot = null
        where id = $1
          and organization_id = $2
          and status = 'running'
          and locked_by = $3
          and locked_at = $4::timestamptz
      returning id`,
      [job.id, job.organization_id, claim.worker_id, claim.acquired_at],
    );
    if (cleared.rowCount !== 1) {
      throw new CatalogPresentationResumeError("catalog_presentation_job_lease_lost");
    }
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
  const reconcile = deps.contracts?.reconcileAcceptedSend ?? reconcileAcceptedSend;
  await assertAgentOperationPg(pool, operation);
  const materializeWith = (alreadySent?: ReadonlySet<string>) =>
    materialize(
      { ok: true, snapshot, reused: true },
      {
        organizationId: job.organization_id,
        conversationId: input.conversationId,
        sendsAlreadyCounted: snapshot.sends_already_counted,
        maxSendsPerTurn: deps.maxSendsPerTurn,
        ...(alreadySent !== undefined ? { alreadySent } : {}),
      },
    );
  let materialized = await materializeWith();
  let sentBefore = 0;
  if (!materialized.ok && materialized.error.code === "source_unavailable") {
    // A origem sumiu (mídia trocada ou apagada com a apresentação adiada) e a
    // cópia da conversa também. Só então se mede o prefixo que o cliente já
    // recebeu, pela mesma regra de seq do executor: mídia entregue não é
    // reenviada, então não depende da origem.
    const prepared = prepareCatalogPresentationPayloads(snapshot.plan);
    const alreadySent = new Set<string>();
    if (prepared.ok) {
      for (const [index, payload] of prepared.prepared.payloads.entries()) {
        const seq = snapshot.sends_already_counted + 1 + index;
        if (!(await reconcile(pool, { tenantId: job.organization_id, jobId: job.id, seq }))) break;
        alreadySent.add(mediaKey(payload.item_index, payload.step_index));
        sentBefore += 1;
      }
    }
    if (alreadySent.size > 0) materialized = await materializeWith(alreadySent);
  }
  if (!materialized.ok && materialized.error.code === "source_unavailable") {
    // Repetir não traz a mídia de volta: sem encerrar, cada tentativa falhava
    // igual até o job morrer com o cliente sem resposta. Encerra como o veto.
    const nextSeq = snapshot.sends_already_counted + 1 + sentBefore;
    await clearSnapshot();
    await insertInboxItem(
      pool,
      job.organization_id,
      {
        kind: "other",
        title: "Apresentação do catálogo interrompida: a mídia do produto mudou",
        body:
          `A foto ou o áudio do produto ${materialized.error.product_code} foi trocado ou removido ` +
          `enquanto a apresentação esperava para continuar. O cliente já tinha recebido ${sentBefore} ` +
          "mensagem(ns); o agente responde o restante com as próprias palavras.",
        refKind: "conversation",
        refId: input.conversationId,
      },
      "kind_ref_e_titulo",
    );
    deps.log.warn("apresentacao do catalogo sem a midia do produto; o modelo responde no lugar", {
      job_id: job.id,
      product_code: materialized.error.product_code,
      media_kind: materialized.error.media_kind,
      sent: sentBefore,
    });
    return {
      handled: true,
      disposition: "vetoed",
      code: CODIGO_MIDIA_DA_APRESENTACAO_INDISPONIVEL,
      message:
        "a foto ou o áudio de um dos produtos foi trocado ou removido no catálogo e não pode mais ser enviado.",
      sent: sentBefore,
      nextSeq,
    };
  }
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
      agentOperation: operation,
      // O veto vira atividade na timeline em nome do agente, não como 'system'.
      agentId: operation.agentId,
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
    // Repetir a mesma sequência não muda o veredito do gate, então 5
    // tentativas só calavam o cliente até o job morrer. Sem isentar o gate:
    // o snapshot é limpo sob o lease e a resposta passa a ser do modelo.
    await clearSnapshot();
    deps.log.warn("apresentacao do catalogo vetada; o modelo responde no lugar", {
      job_id: job.id,
      gate: result.gate,
      code: result.code,
      sent: result.steps.length,
    });
    return {
      handled: true,
      disposition: "vetoed",
      code: result.code,
      message: result.message,
      sent: result.steps.length,
      nextSeq: result.next_seq,
    };
  }

  throw new CatalogPresentationResumeError(failureCode(result));
}
