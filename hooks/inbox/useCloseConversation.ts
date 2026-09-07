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
