"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { Lead } from "@/lib/types/leads";
import type { CreateLeadInput } from "@/lib/schemas/leads";

/**
 * O envelope da criação (issue #1751).
 *
 * `data` é o lead — invariável. `meta.avisos` só existe quando a API tem algo
 * a dizer sem recusar: hoje, `["negocio_aberto_existente"]`, acompanhado de
 * `meta.negocio_aberto_existente` (id + título) para a tela montar o link
 * para o negócio que já estava aberto.
 */
export interface RespostaCriacaoDeLead {
  data: Lead;
  meta?: {
    avisos?: string[];
    negocio_aberto_existente?: { id: string; title: string };
  };
}

export function useCreateLead(pipelineId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateLeadInput) =>
      apiClient.post<RespostaCriacaoDeLead>("/api/v1/leads", input),
    onError: showApiError,
    onSettled: () => qc.invalidateQueries({ queryKey: ["board", pipelineId] }),
  });
}
