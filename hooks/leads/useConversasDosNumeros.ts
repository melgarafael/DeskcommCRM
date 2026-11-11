"use client";
import { useQuery } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import type { NumerosDoNegocio } from "@/app/api/v1/leads/[id]/conversas-e-ligacoes/route";

interface Resposta {
  data: NumerosDoNegocio;
}

/**
 * A CHAVE da leitura agregada, exportada.
 *
 * Mesma razão do `chaveDosContatosRelacionados`: quem escreve (ligar um número
 * ao negócio, mandar mensagem) precisa invalidar a MESMA chave que a tela lê.
 * Com a chave escrita duas vezes, um prefixo a mais em uma das pontas deixa a
 * lista velha na tela sem erro nenhum.
 */
export function chaveDasConversasDosNumeros(leadId: string | null) {
  return ["conversas-dos-numeros", leadId] as const;
}

/**
 * As conversas e as ligações de TODOS os números do negócio (#3669, fatia 1).
 *
 * Sem `leadId` não há rota a consultar — o `enabled` segura a chamada, e quem
 * monta o componente sem âncora não faz rede (a régua de
 * `useContatosRelacionados`).
 */
export function useConversasDosNumeros(leadId: string | null) {
  return useQuery({
    queryKey: chaveDasConversasDosNumeros(leadId),
    enabled: !!leadId,
    queryFn: async () => {
      try {
        return await apiClient.get<Resposta>(`/api/v1/leads/${leadId}/conversas-e-ligacoes`);
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
  });
}
