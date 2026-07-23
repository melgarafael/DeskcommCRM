"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { Note } from "@/lib/types/messaging";

interface CreateNoteArgs {
  conversation_id: string;
  body: string;
}

export function useCreateNote() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ conversation_id, body }: CreateNoteArgs) =>
      apiClient.post<{ data: Note }>(`/api/v1/conversations/${conversation_id}/notes`, { body }),
    onSuccess: (_res, args) => {
      qc.invalidateQueries({ queryKey: ["notes", args.conversation_id] });
    },
    onError: showApiError,
  });
}
