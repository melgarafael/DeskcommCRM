"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import type { AcaoTransicaoAvaliacao } from "@/lib/avaliacao/status";

export function useMutacaoAgendamento() {
  const qc = useQueryClient();

  const invalidar = () => qc.invalidateQueries({ queryKey: ["avaliacao", "agendamentos"] });

  const acao = useMutation({
    mutationFn: async ({ id, acao: nome }: { id: string; acao: AcaoTransicaoAvaliacao }) => {
      return apiClient.post(`/api/v1/avaliacao/agendamentos/${id}/acoes/${nome}`, {});
    },
    onSuccess: invalidar,
    onError: showApiError,
  });

  const excluir = useMutation({
    mutationFn: async (id: string) => apiClient.delete(`/api/v1/avaliacao/agendamentos/${id}`),
    onSuccess: invalidar,
    onError: showApiError,
  });

  const copiarConfirmacao = useMutation({
    mutationFn: async (id: string) => {
      const r = await apiClient.get<{ data: { texto: string } }>(
        `/api/v1/avaliacao/agendamentos/${id}/texto-confirmacao`,
      );
      return r.data.texto;
    },
    onError: showApiError,
  });

  return { acao, excluir, copiarConfirmacao, invalidar };
}
