"use client";
import { usePermission } from "@/hooks/auth/AuthProvider";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useRealtimeChannel } from "@/hooks/realtime/useRealtimeChannel";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { Note } from "@/lib/types/messaging";

/** Onda 5.2: notas internas da conversa (poucas por conversa — query simples, sem paginação). */
export function useConversationNotes(conversationId: string | null) {
  const podeConsultar = usePermission("inbox.notes.view");
  const qc = useQueryClient();
  const queryKey = ["notes", conversationId] as const;

  const query = useQuery({
    queryKey,
    enabled: !!conversationId && podeConsultar,
    queryFn: async () => {
      try {
        return await apiClient.get<{ data: Note[] }>(
          `/api/v1/conversations/${conversationId}/notes`,
        );
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
    select: (res) => res.data,
  });

  const onChange = useCallback(() => {
    if (conversationId) qc.invalidateQueries({ queryKey: ["notes", conversationId] });
  }, [qc, conversationId]);

  useRealtimeChannel({
    name: conversationId ? `conversation-notes-${conversationId}` : "conversation-notes-disabled",
    postgresChanges: conversationId
      ? {
          event: "*",
          schema: "public",
          table: "conversation_notes",
          filter: `conversation_id=eq.${conversationId}`,
        }
      : undefined,
    onChange,
    enabled: !!conversationId && podeConsultar,
  });

  return query.data ?? [];
}
