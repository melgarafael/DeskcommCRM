"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { JanelaDoRelatorio } from "@/lib/relatorios/janela";
import type { PainelDeVendas } from "@/lib/relatorios/painel-de-vendas";

export interface ContatoDoPainel {
  display_name: string | null;
  name: string | null;
  phone_number: string | null;
}

export type RespostaDoPainelDeVendas = PainelDeVendas & {
  janela: JanelaDoRelatorio;
  truncado: boolean;
  contatos: Record<string, ContatoDoPainel>;
  nomes_dos_funis: Record<string, string | null>;
  /** Nome de quem vendeu, por id (sem service role, vem vazio). */
  vendedores?: Record<string, string | null>;
};

export function usePainelDeVendas(periodo: {
  de: string;
  ate: string;
  pipelineId?: string | null;
  tag?: string | null;
}) {
  const pipelineId = periodo.pipelineId || null;
  const tag = periodo.tag || null;
  return useQuery({
    queryKey: ["reports", "painel-de-vendas", periodo.de, periodo.ate, pipelineId, tag],
    queryFn: async () => {
      const params = new URLSearchParams({ de: periodo.de, ate: periodo.ate });
      if (pipelineId) params.set("pipeline_id", pipelineId);
      if (tag) params.set("tag", tag);
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
