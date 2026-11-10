"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { invalidarFichaDoTelefone } from "@/hooks/contacts/invalidarFichaDoTelefone";

/**
 * Troca um extra pelo principal numa operação só: o principal atual vira extra e
 * o extra escolhido passa a ser o número da ficha.
 */
export function useTornarTelefonePrincipal(contactId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (phoneId: string) =>
      apiClient.post<{ data: unknown }>(
        `/api/v1/contacts/${contactId}/phones/${phoneId}/primary`,
        {},
      ),
    onSuccess: () => invalidarFichaDoTelefone(qc, contactId),
  });
}
