"use client";
import { useQuery } from "@tanstack/react-query";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import type { ContatoRelacionado } from "@/app/api/v1/leads/[id]/contatos-relacionados/route";

interface ContatosRelacionadosResponse {
  data: ContatoRelacionado[];
}

/**
 * A CHAVE da lista, exportada.
 *
 * Quem ESCREVE precisa invalidar a MESMA chave que quem LÊ usa. Com a chave
 * escrita duas vezes — uma aqui e outra no hook de escrita — basta um dos dois
 * mudar de forma (um prefixo a mais, um `String(leadId)`) para o POST salvar e a
 * tela continuar mostrando a lista velha: o defeito clássico de "salvei e não
 * mudou nada", sem erro nenhum no console.
 */
export function chaveDosContatosRelacionados(leadId: string | null) {
  return ["contatos-relacionados", leadId] as const;
}

/**
 * As pessoas ligadas ao negócio por `crm_lead_links` (target_kind='contact'),
 * na ordem da #1506 (F1). Sem `leadId` não há rota a consultar — o `enabled`
 * segura a chamada, e quem monta o componente sem âncora não faz rede.
 */
export function useContatosRelacionados(leadId: string | null) {
  return useQuery({
    queryKey: chaveDosContatosRelacionados(leadId),
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
