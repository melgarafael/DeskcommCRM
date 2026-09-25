"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { RoteiroDoContato } from "@/lib/followup/roteiros-do-contato";

/**
 * O que os roteiros de atendimento coletaram do contato. `habilitado = false`
 * (módulo desligado) não faz pedido nenhum — desligado, a tela não muda.
 *
 * Sem toast de erro: a falha aqui é a ausência de uma seção, não da ficha.
 */
export function useRoteirosDoContato(contactId: string, habilitado: boolean) {
  return useQuery({
    queryKey: ["contact", contactId, "roteiros"],
    enabled: Boolean(contactId) && habilitado,
    retry: false,
    queryFn: async () => {
      const r = await apiClient.get<{ data: RoteiroDoContato[] }>(`/api/v1/contacts/${contactId}/roteiros`);
      return r.data;
    },
  });
}
