"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import type { TipoDeTelefone, WhatsappDoTelefone } from "@/lib/types/contacts";
import { invalidarFichaDoTelefone } from "@/hooks/contacts/invalidarFichaDoTelefone";

export interface AdicionarTelefoneInput {
  phone_number: string;
  type?: TipoDeTelefone;
  whatsapp?: WhatsappDoTelefone;
  label?: string;
}

/**
 * `became_primary: true` quando a ficha não tinha principal e o número virou o
 * principal; senão o extra criado volta com o `id` que as outras ações usam.
 */
export interface ResultadoAdicionarTelefone {
  became_primary?: boolean;
  id?: string;
}

export function useAdicionarTelefone(contactId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: AdicionarTelefoneInput) =>
      apiClient.post<{ data: ResultadoAdicionarTelefone }>(
        `/api/v1/contacts/${contactId}/phones`,
        input,
      ),
    onSuccess: () => invalidarFichaDoTelefone(qc, contactId),
  });
}
