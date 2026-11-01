"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { motivoDaFalhaDaMensagem } from "@/lib/inbox/motivo-da-falha";

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
  // Reenvio da mensagem que falhou, na mesma linha. Sem toast: a própria bolha
  // muda (sai de "Falhou"). A recarga é explícita porque a rede de segurança do
  // fio só percebe mensagem nova, não troca de status — e vale também na
  // recusa: a bolha decide com o relógio do aparelho e a rota com o do
  // servidor, e depois de um "não" a bolha tem de mostrar o estado real.
  const reenviar = useMutation({
    mutationFn: ({ id, confirmado }: { id: string; confirmado: boolean }) =>
      apiClient.post<{ data: { status: string; error_code: string | null; error_message: string | null } }>(
        `/api/v1/messages/${id}/retry`,
        confirmado ? { confirmado: true } : {},
      ),
    // O canal recusou de novo: a rota responde 200 (`ok(message)`, o corpo vem
    // em `{ data }`) com a linha em `failed`, e sem este aviso o toque parece
    // não ter feito nada (WhatsApp fora do ar).
    onSuccess: (res) => {
      const msg = res?.data;
      if (msg?.status !== "failed") return;
      toast.error(t("A mensagem não saiu de novo."), { description: motivoDaFalhaDaMensagem(msg, t) });
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["messages", conversationId] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
    },
    // "Confirme antes" não é erro para a pessoa: a bolha abre a confirmação.
    onError: (err) => {
      if (err instanceof ApiError && err.code === "confirmacao_necessaria") return;
      showApiError(err);
    },
  });
  return { editar, apagar, ocultar, restaurar, reenviar };
}
