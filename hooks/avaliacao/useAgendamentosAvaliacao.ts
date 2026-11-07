"use client";

import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { AgendamentoAvaliacao, FiltrosAvaliacaoState } from "@/components/avaliacao/tipos";

export function useAgendamentosAvaliacao(filtros: FiltrosAvaliacaoState | null) {
  return useQuery({
    queryKey: ["avaliacao", "agendamentos", filtros],
    enabled: filtros !== null,
    queryFn: async (): Promise<AgendamentoAvaliacao[]> => {
      if (!filtros) return [];
      const qs = new URLSearchParams({ de: filtros.de, ate: filtros.ate });
      if (filtros.status && filtros.status !== "todos") qs.set("status", filtros.status);
      if (filtros.unit_id) qs.set("unit_id", filtros.unit_id);
      if (filtros.consultant_user_id) qs.set("consultant_user_id", filtros.consultant_user_id);
      if (filtros.attendant_user_id) qs.set("attendant_user_id", filtros.attendant_user_id);
      if (filtros.q) qs.set("q", filtros.q);
      try {
        const r = await apiClient.get<{ data: AgendamentoAvaliacao[] }>(
          `/api/v1/avaliacao/agendamentos?${qs.toString()}`,
        );
        return r.data ?? [];
      } catch (e) {
        showApiError(e);
        throw e;
      }
    },
  });
}
