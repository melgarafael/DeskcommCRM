"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import type { Contact } from "@/lib/types/contacts";

/**
 * Desfaz o descadastro do contato — o override que a regra W-02 prevê
 * ("Tenant admin pode desbloquear manualmente; ação auditada").
 *
 * Invalida as MESMAS chaves de `useUpdateContact`, e a razão está medida lá: o
 * Inbox lê o contato por `conversation.contacts`, não por `["contact", id]`.
 * Sem `["conversations"]`, a conversa seguiria exibindo "Bloqueado" até trocar
 * de conversa — e a tela pareceria não ter feito nada.
 */
export function useUnblockContact(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      apiClient.post<{ data: Contact }>(`/api/v1/contacts/${id}/unblock`, {}),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contact", id] });
      qc.invalidateQueries({ queryKey: ["contacts"] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}
