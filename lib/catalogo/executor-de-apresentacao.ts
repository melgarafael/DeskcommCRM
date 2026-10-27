import type { JobClaim } from "@/lib/agent-engine/queue/claim";
import type {
  ChannelAdapter,
  ChannelSendInput,
  ChannelSendResult,
} from "@/lib/agent-engine/channel-adapter";
import { runBeforeSend, type RunBeforeSendArgs } from "@/lib/agent-engine/guardrails/before-send";
import { reconcileAcceptedSend } from "@/lib/agent-engine/edge/crm/send-ledger";
import type { CatalogPresentationPlan } from "@/lib/catalogo/plano-de-apresentacao";
import {
  prepareCatalogPresentationPayloads,
  type CatalogPresentationPreparationFailure,
  type PreparedCatalogPresentationPayload,
} from "@/lib/catalogo/preparo-de-apresentacao";

type BeforeSendBase = Omit<RunBeforeSendArgs, "body" | "send"> & { jobId: string };

export interface MaterializedCatalogPresentationMedia {
  /** Caminho já materializado dentro da pasta da conversa em `whatsapp-media`. */
  storagePath: string;
}

export interface CatalogPresentationExecutionArgs {
  channel: ChannelAdapter;
  beforeSend: BeforeSendBase;
  conversationId: string;
  jobClaim?: JobClaim;
  /** Quantas mensagens físicas deste turno já ocupam o teto antes desta apresentação. */
  sendsAlreadyCounted: number;
  maxSendsPerTurn: number;
  /**
   * Copia a mídia privada do catálogo para a pasta da conversa. O executor
   * preserva o MIME e o kind preparados; este seam resolve somente o caminho
   * que o ChannelAdapter pode entregar.
   */
  materializeMedia: (
    payload: Extract<PreparedCatalogPresentationPayload, { kind: "audio" | "image" }>,
  ) => Promise<MaterializedCatalogPresentationMedia>;
  /** true interrompe antes de começar o próximo item; nunca corta um item no meio. */
  interruptedBetweenItems?: (input: {
    completed_item_index: number;
    next_item_index: number;
    next_product_id: string;
    next_product_code: string;
  }) => Promise<boolean>;
  /** Pausa antes de cada nova mensagem física, inclusive dentro do mesmo item. */
  pausedBeforeSend?: () => Promise<boolean>;
  /** Seams de teste; produção usa os contratos canônicos. */
  contracts?: {
    beforeSend?: typeof runBeforeSend;
    reconcileAcceptedSend?: typeof reconcileAcceptedSend;
  };
}

export interface CatalogPresentationExecutedStep {
  payload: PreparedCatalogPresentationPayload;
  seq: number;
  outcome: ChannelSendResult | { kind: "already_sent"; reconciled: true };
}

export type CatalogPresentationExecutionResult =
  | {
      status: "completed";
      steps: CatalogPresentationExecutedStep[];
      next_seq: number;
    }
  | {
      status: "not_started";
      reason: "preparation_failed";
      error: CatalogPresentationPreparationFailure;
      steps: [];
      next_seq: number;
    }
  | {
      status: "not_started";
      reason: "max_sends_per_turn";
      required: number;
      remaining: number;
      steps: [];
      next_seq: number;
    }
  | {
      status: "stopped";
      reason: "interrupted";
      next_item_index: number;
      steps: CatalogPresentationExecutedStep[];
      next_seq: number;
    }
  | {
      status: "stopped";
      reason: "vetoed";
      gate: string;
      code: string;
      next_allowed_at?: Date;
      steps: CatalogPresentationExecutedStep[];
      next_seq: number;
    }
  | {
      status: "stopped";
      reason: "queued" | "blocked" | "failed" | "unavailable";
      outcome: ChannelSendResult;
      steps: CatalogPresentationExecutedStep[];
      next_seq: number;
    };

function bodyOf(payload: PreparedCatalogPresentationPayload): string {
  return payload.kind === "text" || payload.kind === "price" ? payload.text : "";
}

function validCount(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

/**
 * Executa um plano já validado, uma mensagem física por vez e na ordem preparada.
 *
 * O preflight do teto acontece antes de qualquer leitura/escrita ou cópia de
 * mídia. Cada seq é derivado da posição física, portanto replay usa a mesma
 * identidade no send_ledger. Entre itens há um ponto explícito de interrupção;
 * a pausa é consultada antes de cada mensagem física ainda não iniciada.
 */
export async function executeCatalogPresentationSerial(
  plan: CatalogPresentationPlan,
  args: CatalogPresentationExecutionArgs,
): Promise<CatalogPresentationExecutionResult> {
  if (!validCount(args.sendsAlreadyCounted) || !validCount(args.maxSendsPerTurn)) {
    throw new RangeError("catalog_presentation_invalid_send_limit");
  }

  const nextSeqAtStart = args.sendsAlreadyCounted + 1;
  const preparation = prepareCatalogPresentationPayloads(plan);
  if (!preparation.ok) {
    return {
      status: "not_started",
      reason: "preparation_failed",
      error: preparation.error,
      steps: [],
      next_seq: nextSeqAtStart,
    };
  }

  const remaining = Math.max(0, args.maxSendsPerTurn - args.sendsAlreadyCounted);
  if (preparation.prepared.physical_payload_count > remaining) {
    return {
      status: "not_started",
      reason: "max_sends_per_turn",
      required: preparation.prepared.physical_payload_count,
      remaining,
      steps: [],
      next_seq: nextSeqAtStart,
    };
  }

  const guard = args.contracts?.beforeSend ?? runBeforeSend;
  const reconcile = args.contracts?.reconcileAcceptedSend ?? reconcileAcceptedSend;
  const steps: CatalogPresentationExecutedStep[] = [];
  let previousItemIndex: number | null = null;

  for (const [payloadIndex, payload] of preparation.prepared.payloads.entries()) {
    if (previousItemIndex !== null && payload.item_index !== previousItemIndex) {
      const interrupted = await args.interruptedBetweenItems?.({
        completed_item_index: previousItemIndex,
        next_item_index: payload.item_index,
        next_product_id: payload.product_id,
        next_product_code: payload.product_code,
      });
      if (interrupted === true) {
        return {
          status: "stopped",
          reason: "interrupted",
          next_item_index: payload.item_index,
          steps,
          next_seq: nextSeqAtStart + payloadIndex,
        };
      }
    }
    previousItemIndex = payload.item_index;

    if (await args.pausedBeforeSend?.()) {
      return {
        status: "stopped",
        reason: "interrupted",
        next_item_index: payload.item_index,
        steps,
        next_seq: nextSeqAtStart + payloadIndex,
      };
    }

    const seq = nextSeqAtStart + payloadIndex;
    const accepted = await reconcile(args.beforeSend.pool, {
      tenantId: args.beforeSend.tenantId,
      jobId: args.beforeSend.jobId,
      seq,
    });
    if (accepted) {
      steps.push({ payload, seq, outcome: { kind: "already_sent", reconciled: true } });
      continue;
    }

    const guarded = await guard({
      ...args.beforeSend,
      body: bodyOf(payload),
      send: async (finalBody) => {
        let media: ChannelSendInput["media"];
        if (payload.kind === "audio" || payload.kind === "image") {
          const materialized = await args.materializeMedia(payload);
          media = {
            kind: payload.kind,
            storagePath: materialized.storagePath,
            mime: payload.media.mime,
          };
        }
        return args.channel.send({
          tenantId: args.beforeSend.tenantId,
          leadId: args.beforeSend.leadId,
          jobId: args.beforeSend.jobId,
          seq,
          conversationId: args.conversationId,
          body: finalBody,
          ...(args.beforeSend.agentOperation !== undefined
            ? { agentOperation: args.beforeSend.agentOperation }
            : {}),
          ...(args.jobClaim !== undefined ? { jobClaim: args.jobClaim } : {}),
          ...(media !== undefined ? { media } : {}),
        });
      },
    });

    if (guarded.status === "vetoed") {
      return {
        status: "stopped",
        reason: "vetoed",
        gate: guarded.gate,
        code: guarded.code,
        ...(guarded.nextAllowedAt !== undefined ? { next_allowed_at: guarded.nextAllowedAt } : {}),
        steps,
        next_seq: seq,
      };
    }

    steps.push({ payload, seq, outcome: guarded.outcome });
    if (
      guarded.outcome.kind === "queued" ||
      guarded.outcome.kind === "blocked" ||
      guarded.outcome.kind === "failed" ||
      guarded.outcome.kind === "unavailable"
    ) {
      return {
        status: "stopped",
        reason: guarded.outcome.kind,
        outcome: guarded.outcome,
        steps,
        // queued/failed/unavailable ainda pertencem a ESTE seq no ledger; um
        // replay precisa reconciliar ou repetir a mesma intenção, nunca pulá-la.
        next_seq: seq,
      };
    }
  }

  return {
    status: "completed",
    steps,
    next_seq: nextSeqAtStart + preparation.prepared.payloads.length,
  };
}
