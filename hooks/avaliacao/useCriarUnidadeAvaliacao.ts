"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import type { UnidadeAvaliacao } from "@/hooks/avaliacao/useUnidadesAvaliacao";

export function useCriarUnidadeAvaliacao() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => {
      const r = await apiClient.post<{ data: UnidadeAvaliacao }>("/api/v1/avaliacao/unidades", {
        name: name.trim(),
      });
      return r.data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["avaliacao", "unidades"] });
    },
    onError: showApiError,
  });
}
