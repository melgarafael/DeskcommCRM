"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

export interface ConversationCounts {
  unassigned: number;
  mine: number;
  all: number;
}

/**
 * Contagens por visão do inbox (G4-02). O endpoint usa o client RLS-scoped —
 * um agent em modo own* recebe a contagem do seu escopo, não o total da org.
 */
export function useConversationCounts(orgId: string | null) {
  return useQuery({
    queryKey: ["conversation-counts", orgId],
    enabled: !!orgId,
    refetchInterval: 30_000,
    queryFn: () =>
      apiClient
        .get<{ data: ConversationCounts }>("/api/v1/conversations/counts")
        .then((r) => r.data),
  });
}
