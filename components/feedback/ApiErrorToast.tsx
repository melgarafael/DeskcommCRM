"use client";

import { toast } from "sonner";
import { ApiError } from "@/lib/api/types";

type Variant = "error" | "warning" | "info";

const COPY: Record<string, { variant: Variant; msg: string }> = {
  body_malformed: {
    variant: "error",
    msg: "Requisição inválida. Recarregue e tente de novo.",
  },
  cursor_malformed: {
    variant: "error",
    msg: "Falha ao paginar. Volte ao início.",
  },
  validation_error: {
    variant: "error",
    msg: "Dados inválidos. Confira os campos destacados.",
  },
  auth_required: {
    variant: "warning",
    msg: "Sessão expirada. Faça login novamente.",
  },
  forbidden_role: {
    variant: "warning",
    msg: "Você não tem permissão para esta ação.",
  },
  resource_not_found: {
    variant: "error",
    msg: "Recurso não encontrado ou já removido.",
  },
  tenant_not_found: {
    variant: "error",
    msg: "Organização não encontrada.",
  },
  idempotency_conflict: {
    variant: "warning",
    msg: "Operação já processada.",
  },
  conversation_already_claimed: {
    variant: "warning",
    msg: "Outro atendente já assumiu.",
  },
  invalid_state: {
    variant: "warning",
    msg: "Este caso já foi respondido ou fechado.",
  },
  rate_limited: {
    variant: "warning",
    msg: "Muitas tentativas. Aguarde alguns segundos.",
  },
  lgpd_anonymization_irreversible: {
    variant: "error",
    msg: "Esta ação não pode ser desfeita: o contato já foi anonimizado.",
  },
  internal_error: {
    variant: "error",
    msg: "Erro interno. Tente de novo em instantes.",
  },
};

export function showApiError(err: unknown): void {
  if (err instanceof ApiError) {
    const entry = COPY[err.code];
    const description = err.requestId ? `ID: ${err.requestId}` : undefined;
    if (entry) {
      const fn =
        entry.variant === "warning"
          ? toast.warning
          : entry.variant === "info"
            ? toast.info
            : toast.error;
      fn(entry.msg, { description });
      return;
    }
    toast.error(err.message || err.code, { description });
    return;
  }
  toast.error("Erro inesperado. Tente novamente.");
}

export function useApiErrorHandler(): (err: unknown) => void {
  return showApiError;
}
