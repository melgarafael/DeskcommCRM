"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";

/** Recarrega o fio após o canal confirmar, sem fingir sucesso antes da resposta. */
export function useAlterarMensagem(conversationId: string | null) {
  const qc = useQueryClient();
  const t = useT();
  const editar = useMutation({
    mutationFn: ({ id, text }: { id: string; text: string }) =>
      apiClient.patch(`/api/v1/messages/${id}`, { text }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["messages", conversationId] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
      toast.success(t("Mensagem editada."));
    },
    onError: showApiError,
  });
  const apagar = useMutation({
    mutationFn: (id: string) => apiClient.delete(`/api/v1/messages/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["messages", conversationId] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
      toast.success(t("Mensagem apagada para todos."));
    },
    onError: showApiError,
  });
  const ocultar = useMutation({
    mutationFn: (id: string) => apiClient.post(`/api/v1/messages/${id}/hide`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["messages", conversationId] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
      toast.success(t("Mensagem ocultada no CRM."));
    },
    onError: showApiError,
  });
  const restaurar = useMutation({
    mutationFn: (id: string) => apiClient.delete(`/api/v1/messages/${id}/hide`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["messages", conversationId] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
      toast.success(t("Mensagem restaurada no CRM."));
    },
    onError: showApiError,
  });
  return { editar, apagar, ocultar, restaurar };
}
