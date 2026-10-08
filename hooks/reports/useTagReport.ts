"use client";
import { useQuery } from "@tanstack/react-query";

import { fusoDoNavegador } from "@/hooks/reports/useActivityReport";
import { apiClient } from "@/lib/api/client";
import { janelaDeDias, type RelatorioPorEtiqueta } from "@/lib/reports/etiquetas";

/**
 * `GET /api/v1/reports/tags?de&ate&tz` (#1888) — a tela da #1891.
 *
 * `de`/`ate` saem do seletor de PERÍODO que as outras abas de Relatórios já
 * usam (7, 30, 90 dias), e o `tz` vai junto pela mesma razão de
 * `useActivityReport`: a janela é DIÁRIA no fuso de quem lê, e sem o fuso o
 * "últimos 7 dias" de quem olha às 21h de Brasília começaria em UTC — três
 * horas de conversa nascendo ou desaparecendo conforme o país.
 */
export function useTagReport(dias: number) {
  const tz = fusoDoNavegador();
  const { de, ate } = janelaDeDias(dias);
  return useQuery({
    queryKey: ["reports", "tags", de, ate, tz],
    queryFn: async () =>
      apiClient.get<{ data: RelatorioPorEtiqueta }>(
        `/api/v1/reports/tags?de=${de}&ate=${ate}&tz=${encodeURIComponent(tz)}`,
      ),
    staleTime: 30_000,
  });
}
