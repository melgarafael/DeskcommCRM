"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import type { TipoDeTelefone, WhatsappDoTelefone } from "@/lib/types/contacts";
import { invalidarFichaDoTelefone } from "@/hooks/contacts/invalidarFichaDoTelefone";

/**
 * Tipo e WhatsApp do número PRINCIPAL. Vai pelo PATCH da própria ficha, que
 * aceita esses dois campos (o principal não tem rótulo).
 */
export function useEditarTelefonePrincipal(contactId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: { phone_type?: TipoDeTelefone; phone_whatsapp?: WhatsappDoTelefone }) =>
      apiClient.patch<{ data: unknown }>(`/api/v1/contacts/${contactId}`, patch),
    onSuccess: () => invalidarFichaDoTelefone(qc, contactId),
  });
}
