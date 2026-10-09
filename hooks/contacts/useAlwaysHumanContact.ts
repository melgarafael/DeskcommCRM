"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import type { Contact } from "@/lib/types/contacts";

/**
 * Liga/desliga a marca PERMANENTE "sempre atendimento humano" (issue 2379).
 *
 * Espelha `useMarkPersonalContact` e invalida as MESMAS chaves: o Inbox lê o
 * contato por `conversation.contacts`, então sem invalidar `["conversations"]`
 * a marca pareceria não fazer nada fora da ficha.
 *
 * Ligar também trava a conversa (`force_human`), então invalidamos os crons e
 * as filas que decidem pela IA — o efeito é duradouro, não só visual.
 */
export function useMarkAlwaysHumanContact(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      apiClient.post<{ data: Contact }>(`/api/v1/contacts/${id}/always-human`, {}),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contact", id] });
      qc.invalidateQueries({ queryKey: ["contacts"] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}

/**
 * Desliga a marca permanente. NÃO devolve o atendimento: a conversa continua
 * com a trava de handoff de quem a pôs, e devolvê-la é o gesto explícito do
 * botão "Devolver ao automático". Mesmas chaves invalidadas pelo mesmo motivo.
 */
export function useUnmarkAlwaysHumanContact(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      apiClient.delete<{ data: Contact }>(`/api/v1/contacts/${id}/always-human`),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contact", id] });
      qc.invalidateQueries({ queryKey: ["contacts"] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}
