"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";

/**
 * Apaga TUDO de um contato pela tela da conversa (C-104).
 *
 * É a rota `/api/v1/contacts/:id/apagar`, mais forte que a exclusão comum de
 * contato: some também o resíduo que fazia o agente "lembrar" o cliente. Ao
 * concluir, invalida contatos e conversas — a lista tem de perder a linha.
 */
export function useApagarDadosDoContato() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (contactId: string) =>
      apiClient.delete<{ counts: Record<string, number> }>(
        `/api/v1/contacts/${contactId}/apagar`,
      ),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contacts"] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}
