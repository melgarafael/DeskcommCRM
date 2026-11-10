"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import type { TipoDeTelefone, WhatsappDoTelefone } from "@/lib/types/contacts";
import { invalidarFichaDoTelefone } from "@/hooks/contacts/invalidarFichaDoTelefone";

/** Pelo menos um dos três campos; o que não vier fica como está. */
export interface EditarTelefoneInput {
  type?: TipoDeTelefone;
  whatsapp?: WhatsappDoTelefone;
  label?: string | null;
}

/** Edita tipo, WhatsApp e rótulo de um telefone EXTRA da ficha. */
export function useEditarTelefone(contactId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ phoneId, ...patch }: EditarTelefoneInput & { phoneId: string }) =>
      apiClient.patch<{ data: unknown }>(`/api/v1/contacts/${contactId}/phones/${phoneId}`, patch),
    onSuccess: () => invalidarFichaDoTelefone(qc, contactId),
  });
}
