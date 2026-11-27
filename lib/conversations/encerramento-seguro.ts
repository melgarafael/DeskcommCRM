import type { SupabaseClient } from "@supabase/supabase-js";
import type { Conversation } from "@/lib/types/messaging";
import { ApiError } from "@/lib/api/types";

export type MotivoConflitoEncerramento =
  | "service_revision_mismatch"
  | "status_changed"
  | "assignee_changed"
  | "sector_changed"
  | "human_attendance_active"
  | "new_inbound_message"
  | "open_agent_case"
  | "open_proposal"
  | "open_task"
  | "open_human_demand"
  | "service_contact_changed";

export interface OpcoesEncerramentoSeguro {
  expectedRevision?: number;
  safeClose?: boolean;
  expectedStatus?: string;
  expectedLastInboundMessageId?: string | null;
  expectedLastInboundAt?: string | null;
  expectedAssignedToUserId?: string | null;
  expectedSectorId?: string | null;
  idempotencyKey?: string;
}

export interface ResultadoEncerramentoSeguro {
  closed: boolean;
  already_closed: boolean;
  idempotent_replay: boolean;
  last_inbound_message_id: string | null;
  conversation: Conversation;
}

const MENSAGENS_POR_MOTIVO: Record<MotivoConflitoEncerramento, string> = {
  service_revision_mismatch:
    "O atendimento mudou desde a última leitura. Atualize a conversa antes de encerrar.",
  status_changed: "O status da conversa foi alterado antes do encerramento.",
  assignee_changed: "O responsável pela conversa foi alterado antes do encerramento.",
  sector_changed: "O departamento/setor da conversa foi alterado antes do encerramento.",
  human_attendance_active:
    "A conversa está em atendimento humano ou com a automação silenciada e não pode ser encerrada automaticamente.",
  new_inbound_message:
    "Uma nova mensagem do cliente foi recebida após a avaliação de encerramento.",
  open_agent_case: "Existe um caso de atendimento aberto aguardando resolução nesta conversa.",
  open_proposal: "Existe uma proposta comercial em aberto vinculada a esta conversa.",
  open_task: "Existe uma tarefa pendente vinculada ao contato desta conversa.",
  open_human_demand: "Existe uma demanda em atendimento humano ainda aberta para esta conversa.",
  service_contact_changed:
    "O contato vinculado à conversa mudou durante a operação. Tente novamente.",
};

/**
 * Indica se a chamada acionou o modo condicional de encerramento seguro
 * (explicitamente via `safeClose: true` ou pelo envio de qualquer pré-condição).
 */
export function usaEncerramentoSeguro(opcoes: OpcoesEncerramentoSeguro): boolean {
  return (
    opcoes.safeClose === true ||
    opcoes.expectedStatus !== undefined ||
    opcoes.expectedLastInboundMessageId !== undefined ||
    opcoes.expectedLastInboundAt !== undefined ||
    opcoes.expectedAssignedToUserId !== undefined ||
    opcoes.expectedSectorId !== undefined ||
    opcoes.idempotencyKey !== undefined
  );
}

function extrairDetalhesConflito(error: {
  code?: string;
  message?: string;
  details?: string | null;
}): { reason: MotivoConflitoEncerramento; details: Record<string, unknown> } {
  let parsedDetails: Record<string, unknown> = {};
  if (typeof error.details === "string" && error.details.trim().startsWith("{")) {
    try {
      const obj = JSON.parse(error.details) as unknown;
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        parsedDetails = obj as Record<string, unknown>;
      }
    } catch {
      // ignora detalhe não-JSON
    }
  }

  let reason: MotivoConflitoEncerramento = "service_revision_mismatch";
  if (typeof parsedDetails.reason === "string" && parsedDetails.reason in MENSAGENS_POR_MOTIVO) {
    reason = parsedDetails.reason as MotivoConflitoEncerramento;
  } else if (
    typeof error.message === "string" &&
    error.message.startsWith("safe_close_conflict:")
  ) {
    const candidato = error.message.slice("safe_close_conflict:".length).trim();
    if (candidato in MENSAGENS_POR_MOTIVO) {
      reason = candidato as MotivoConflitoEncerramento;
    }
  } else if (error.code === "40001") {
    reason = "service_contact_changed";
  }

  return {
    reason,
    details: { ...parsedDetails, reason },
  };
}

export function temAncoraDeConcorrencia(opcoes: OpcoesEncerramentoSeguro): boolean {
  return (
    opcoes.expectedRevision !== undefined &&
    (opcoes.expectedLastInboundMessageId !== undefined ||
      opcoes.expectedLastInboundAt !== undefined)
  );
}

/**
 * Executa o encerramento condicional atômico no Postgres via `fn_safe_close_conversation`.
 * Todas as pré-condições são revalidadas sob `fn_service_lock` + `FOR NO KEY UPDATE`.
 */
export async function fecharConversaComSeguranca(
  adminClient: SupabaseClient,
  params: {
    organizationId: string;
    conversationId: string;
    requestId: string;
    opcoes: OpcoesEncerramentoSeguro;
  },
): Promise<ResultadoEncerramentoSeguro> {
  const { organizationId, conversationId, requestId, opcoes } = params;

  if (!temAncoraDeConcorrencia(opcoes)) {
    throw new ApiError(
      422,
      "validation_failed",
      undefined,
      requestId,
      "Encerramento seguro exige expected_revision e expected_last_inbound_message_id (ou expected_last_inbound_at).",
    );
  }

  const { data, error } = await adminClient.rpc("fn_safe_close_conversation", {
    p_org: organizationId,
    p_conversation: conversationId,
    p_expected_revision: opcoes.expectedRevision ?? null,
    p_expected_status: opcoes.expectedStatus ?? null,
    p_expected_last_inbound_message_id: opcoes.expectedLastInboundMessageId ?? null,
    p_enforce_last_inbound_message: opcoes.expectedLastInboundMessageId !== undefined,
    p_expected_last_inbound_at: opcoes.expectedLastInboundAt ?? null,
    p_expected_assignee: opcoes.expectedAssignedToUserId ?? null,
    p_enforce_assignee: opcoes.expectedAssignedToUserId !== undefined,
    p_expected_sector_id: opcoes.expectedSectorId ?? null,
    p_enforce_sector: opcoes.expectedSectorId !== undefined,
    p_reject_human_assigned: true,
    p_reject_open_pendencies: true,
    p_idempotency_key: opcoes.idempotencyKey ?? null,
  });

  if (error) {
    if (error.code === "P0002") {
      throw new ApiError(404, "not_found", undefined, requestId, "Conversa não encontrada.");
    }
    if (error.code === "PT409" || error.code === "40001") {
      const { reason, details } = extrairDetalhesConflito(error);
      throw new ApiError(409, "conflict", details, requestId, MENSAGENS_POR_MOTIVO[reason]);
    }
    throw new ApiError(500, "internal_error", undefined, requestId, error.message);
  }

  return data as unknown as ResultadoEncerramentoSeguro;
}
