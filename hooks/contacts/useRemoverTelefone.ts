"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { invalidarFichaDoTelefone } from "@/hooks/contacts/invalidarFichaDoTelefone";

/** Remove um telefone EXTRA da ficha. O principal sai por outro caminho. */
export function useRemoverTelefone(contactId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (phoneId: string) =>
      apiClient.delete<{ data: unknown }>(`/api/v1/contacts/${contactId}/phones/${phoneId}`),
    onSuccess: () => invalidarFichaDoTelefone(qc, contactId),
  });
}
