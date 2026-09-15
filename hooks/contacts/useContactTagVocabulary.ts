"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

/** Tags em uso nos contatos da org (sugestões do editor). Espelho de `useConversationTagVocabulary`. */
export function useContactTagVocabulary(orgId: string | null) {
  return useQuery({
    queryKey: ["contact-tag-vocabulary", orgId],
    enabled: !!orgId,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<string[]> => {
      const res = await apiClient.get<{ data: string[] }>("/api/v1/contact-tags");
      return res.data;
    },
  });
}
