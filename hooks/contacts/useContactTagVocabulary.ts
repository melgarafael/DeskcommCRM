"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

/** Busca digitada consulta o vocabulário curado inteiro; sem busca conserva sugestões recentes.
 * Falha aparece no editor do Inbox, sem emitir toast repetido em consulta de fundo. */
export function useContactTagVocabulary(orgId: string | null, busca = "") {
  return useQuery({
    queryKey: ["contact-tag-vocabulary", orgId, busca],
    enabled: !!orgId,
    staleTime: 5 * 60_000,
    queryFn: async ({ signal }): Promise<string[]> => {
      const res = busca
        ? await apiClient.get<{ data: string[] }>("/api/v1/contact-tags?busca="+encodeURIComponent(busca), { signal })
        : await apiClient.get<{ data: string[] }>("/api/v1/contact-tags");
      return res.data;
    },
  });
}
