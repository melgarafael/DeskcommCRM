"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { TaxaDaEtapa } from "@/lib/metrics/taxa-da-etapa";

/**
 * A taxa histórica de ganho de cada etapa (issue #1753) — a contagem que a tela
 * de etapas mostra AO LADO do campo de probabilidade.
 *
 * ⚠️ É UMA LEITURA SEPARADA, com chave própria, e não entra no
 * `useAgentMapping`. Os dois mudam por motivos diferentes: o funil muda quando
 * alguém edita uma etapa, a taxa muda quando um negócio é movido. Colar as duas
 * na mesma chave faria a tela de etapas recarregar a cada card arrastado no
 * kanban — e o contrário, invalidar a taxa a cada rename, buscaria 10 mil
 * atividades por nada.
 *
 * ⚠️ A RESPOSTA NÃO É CONFIÁVEL POR FORMATO. `apiClient.get` devolve o corpo
 * que a rota mandou, e quem lê confere `Array.isArray(taxas)` antes de usá-lo:
 * uma leitura em cache de outra rota (ou o corpo de erro de um proxy) parado
 * nesta chave não pode virar «sem dados» na tela do gestor.
 */
export interface RespostaDasTaxas {
  inicio: string;
  fim: string;
  dias: number;
  /** A leitura bateu o teto: o número é AMOSTRA do período, não o período. */
  truncado: boolean;
  minimo_de_casos: number;
  taxas: TaxaDaEtapa[];
}

export const chaveDasTaxas = (pipelineId: string) => ["stage-win-rates", pipelineId];

const rota = (pipelineId: string) =>
  `/api/v1/pipelines/${encodeURIComponent(pipelineId)}/stages/win-rates`;

export function useTaxasDasEtapas(pipelineId: string) {
  return useQuery({
    queryKey: chaveDasTaxas(pipelineId),
    queryFn: () => apiClient.get<{ data: RespostaDasTaxas }>(rota(pipelineId)).then((r) => r.data),
  });
}
