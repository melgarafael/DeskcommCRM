"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { Conversation } from "@/lib/types/messaging";

interface TransferArgs {
  conversation_id: string;
  to_user_id: string;
  reason?: string;
}

/** G3-01: transferência imediata (decisão G1-06d) — POST /transfer grava o evento auditável. */
export function useTransferConversation() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (args: TransferArgs) =>
      apiClient.post<{ data: Conversation }>(
        `/api/v1/conversations/${args.conversation_id}/transfer`,
        { to_user_id: args.to_user_id, ...(args.reason ? { reason: args.reason } : {}) },
      ),
    onError: (err, args) => {
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["conversation", args.conversation_id] });
      showApiError(err);
    },
    onSuccess: (_data, args) => {
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["conversation", args.conversation_id] });
      toast.success("Conversa transferida.");
    },
  });
}
