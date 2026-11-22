"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";

/**
 * "Não tem interesse" pela ficha (decisão D3): grava a recusa de marketing e encerra o
 * negócio aberto da prospecção. Invalida o contato (o selo e a aba LGPD leem
 * `consent`) e os negócios (o card foi para Perdido).
 */
export function useMarcarSemInteresse(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      apiClient.post<{ data: { gravado: boolean; negocios_fechados: number; followups_encerrados: number } }>(
        `/api/v1/contacts/${id}/sem-interesse`,
        {},
      ),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contact", id] });
      qc.invalidateQueries({ queryKey: ["contacts"] });
      qc.invalidateQueries({ queryKey: ["leads"] });
    },
  });
}

/** Desfaz a recusa "sem interesse" (aba LGPD, só admin). Não reabre o negócio. */
export function useDesfazerSemInteresse(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      apiClient.delete<{ data: { desfeito: boolean } }>(`/api/v1/contacts/${id}/sem-interesse`),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contact", id] });
      qc.invalidateQueries({ queryKey: ["contacts"] });
    },
  });
}
