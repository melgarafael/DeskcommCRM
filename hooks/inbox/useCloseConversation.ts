"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { Conversation } from "@/lib/types/messaging";

interface CloseArgs {
  conversation_id: string;
  expected_revision?: number;
}

export function useCloseConversation() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (args: CloseArgs) =>
      apiClient.post<{ data: Conversation }>(
        `/api/v1/conversations/${args.conversation_id}/close`,
        { expected_revision: args.expected_revision },
      ),
    onError: (err, args) => {
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["conversation", args.conversation_id] });
      showApiError(err);
    },
    onSuccess: (_data, args) => {
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["conversation", args.conversation_id] });
    },
  });
}

/**
 * ARQUIVAR (#923) — tira a conversa do fluxo vivo sem destruir nada.
 *
 * Vai pelo mesmo PATCH versionado da reabertura, com `status: "archived"`: quem
 * aplica é a `fn_service_status`, com o lock otimista de sempre. Não existe rota
 * nova porque arquivar NÃO é um efeito colateral — é a mesma transição de status
 * que a API já aceita, e uma rota dedicada só criaria um segundo caminho para o
 * mesmo UPDATE.
 */
export function useArchiveConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: CloseArgs) => apiClient.patch<{ data: Conversation }>(
      `/api/v1/conversations/${args.conversation_id}`,
      { status: "archived", expected_revision: args.expected_revision },
    ),
    // `onSettled`, e não `onSuccess`: mesmo no 409 (alguém mexeu na conversa
    // entre a leitura e este clique) a tela precisa reler — é o estado do
    // servidor que vale, não o que estava no cache.
    onError: showApiError,
    onSettled: (_data, _error, args) => {
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["conversation", args.conversation_id] });
    },
  });
}

/** Reabertura explícita preserva as proteções de automação do contato. */
export function useReopenConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: CloseArgs) => apiClient.patch<{ data: Conversation }>(
      `/api/v1/conversations/${args.conversation_id}`,
      { status: "open", expected_revision: args.expected_revision },
    ),
    onError: showApiError,
    onSettled: (_data, _error, args) => {
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["conversation", args.conversation_id] });
    },
  });
}
