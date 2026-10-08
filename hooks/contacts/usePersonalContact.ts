"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import type { Contact } from "@/lib/types/contacts";

/**
 * Marca/desmarca o contato como pessoal (spec 21 — botão no cabeçalho da
 * conversa e na ficha do contato).
 *
 * Espelha `useUnblockContact` e invalida as MESMAS chaves, pelo mesmo motivo:
 * o Inbox lê o contato por `conversation.contacts`, não por `["contact", id]`.
 * Sem `["conversations"]`, marcar pareceria não fazer nada até trocar de
 * conversa — e a conversa seguiria na lista que deveria tê-la escondido.
 */
export function useMarkPersonalContact(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      apiClient.post<{ data: Contact }>(`/api/v1/contacts/${id}/personal`, {}),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contact", id] });
      qc.invalidateQueries({ queryKey: ["contacts"] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}

/** O desmarcar: mesma rota, verbo DELETE (D8 — não reativa nada). */
export function useUnmarkPersonalContact(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      apiClient.delete<{ data: Contact }>(`/api/v1/contacts/${id}/personal`),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contact", id] });
      qc.invalidateQueries({ queryKey: ["contacts"] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}
