"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { JanelaDoRelatorio } from "@/lib/relatorios/janela";
import type { PainelDeVendas } from "@/lib/relatorios/painel-de-vendas";

export type RespostaDoPainelDeVendas = PainelDeVendas & {
  janela: JanelaDoRelatorio;
  truncado: boolean;
};

export function usePainelDeVendas(periodo: { de: string; ate: string }) {
  return useQuery({
    queryKey: ["reports", "painel-de-vendas", periodo.de, periodo.ate],
    queryFn: async () => {
      const params = new URLSearchParams({ de: periodo.de, ate: periodo.ate });
      return apiClient.get<{ data: RespostaDoPainelDeVendas }>(
        `/api/v1/reports/painel-de-vendas?${params.toString()}`,
      );
    },
    staleTime: 30_000,
    // Trocar o período mantém os cartões na tela até a resposta nova chegar:
    // sem isto, cada clique num atalho piscava a tela inteira em "Carregando…".
    placeholderData: keepPreviousData,
  });
}
