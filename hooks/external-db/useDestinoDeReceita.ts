"use client";

import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";

export interface FunilParaDestino {
  id: string;
  name: string;
}

export interface EtapaParaDestino {
  id: string;
  name: string;
  is_won: boolean;
  is_lost: boolean;
}

/**
 * Os funis da organização, para o admin escolher o destino do lead de interesse
 * (Spec 25 R5). A rota exige `manager`: quem não escreve receita não pede (`enabled`).
 * O servidor confere de novo, na gravação, que funil e etapa são desta organização.
 */
export function useFunisParaDestino(enabled: boolean) {
  return useQuery({
    queryKey: ["external-db", "destino", "funis"],
    enabled,
    staleTime: 60_000,
    queryFn: async () => (await apiClient.get<{ data: FunilParaDestino[] }>("/api/v1/pipelines")).data,
  });
}

/** As etapas VIVAS do funil escolhido. Ganho e perda entram na lista; o servidor recusa as duas como destino. */
export function useEtapasParaDestino(pipelineId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["external-db", "destino", "etapas", pipelineId],
    enabled: enabled && !!pipelineId,
    staleTime: 60_000,
    queryFn: async () =>
      (await apiClient.get<{ data: EtapaParaDestino[] }>(`/api/v1/pipelines/${pipelineId}/stages`)).data,
  });
}
