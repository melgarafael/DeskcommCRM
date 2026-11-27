"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { parametrosDaJanela, type JanelaDeMetricas } from "@/lib/metrics/periodo-do-desempenho";
import type { RelatorioDePerdas } from "@/lib/metrics/perdas";

export interface PerdasPayload extends RelatorioDePerdas {
  janela: { from: string; to: string };
  /** A leitura bateu no teto: o relatório está cortado, não completo. */
  truncado: boolean;
}

/** Relatório "Perdas" (issue #1537) — manager+, pela janela da tela. */
export function usePerdasMetrics(janela: JanelaDeMetricas) {
  const busca = parametrosDaJanela(janela);
  return useQuery({
    queryKey: ["metrics", "perdas", janela],
    queryFn: async () => apiClient.get<{ data: PerdasPayload }>(`/api/v1/metrics/lost${busca.size ? `?${busca}` : ""}`),
    staleTime: 30_000,
    enabled: janela !== undefined,
  });
}
