"use client";

import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";

export interface UnidadeAvaliacao {
  id: string;
  name: string;
  sort_order: number;
  is_active: boolean;
}

export function useUnidadesAvaliacao() {
  return useQuery({
    queryKey: ["avaliacao", "unidades"],
    queryFn: async () => {
      const r = await apiClient.get<{ data: UnidadeAvaliacao[] }>("/api/v1/avaliacao/unidades");
      return r.data ?? [];
    },
    staleTime: 60_000,
  });
}
