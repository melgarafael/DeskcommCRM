"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import type { RelatorioDePerdas } from "@/lib/metrics/perdas";

export interface PerdasPayload extends RelatorioDePerdas {
  janela: { from: string; to: string };
  /** A leitura bateu no teto: o relatório está cortado, não completo. */
  truncado: boolean;
}

/** Relatório "Perdas" (issue #1537) — manager+, janela de 30 dias. */
export function usePerdasMetrics(enabled = true) {
  return useQuery({
    queryKey: ["metrics", "perdas"],
    queryFn: async () => apiClient.get<{ data: PerdasPayload }>("/api/v1/metrics/lost"),
    staleTime: 30_000,
    enabled,
  });
}
