"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";

/**
 * Onda 5.2: apaga uma nota interna. O backend só permite ao autor ou manager+
 * (403 caso contrário) — a UI já esconde o botão de quem não pode, mas o
 * servidor é a barreira real.
 */
export function useDeleteNote(conversationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (noteId: string) =>
      apiClient.delete(`/api/v1/conversations/${conversationId}/notes/${noteId}`),
    onError: showApiError,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notes", conversationId] }),
  });
}
