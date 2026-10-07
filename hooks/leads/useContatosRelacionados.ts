"use client";
import { useQuery } from "@tanstack/react-query";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import type { ContatoRelacionado } from "@/app/api/v1/leads/[id]/contatos-relacionados/route";

interface ContatosRelacionadosResponse {
  data: ContatoRelacionado[];
}

/**
 * As pessoas ligadas ao negócio por `crm_lead_links` (target_kind='contact'),
 * na ordem da #1506 (F1). Sem `leadId` não há rota a consultar — o `enabled`
 * segura a chamada, e quem monta o componente sem âncora não faz rede.
 */
export function useContatosRelacionados(leadId: string | null) {
  return useQuery({
    queryKey: ["contatos-relacionados", leadId],
    enabled: !!leadId,
    queryFn: async () => {
      try {
        return await apiClient.get<ContatosRelacionadosResponse>(
          `/api/v1/leads/${leadId}/contatos-relacionados`,
        );
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
  });
}
