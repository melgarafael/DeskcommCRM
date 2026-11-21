"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import type { VendaRegistrada } from "@/lib/vendas/registradas";

/** As vendas registradas de um negócio, da mais recente para a mais antiga. */
export function useVendasDoNegocio(leadId: string | null) {
  return useQuery({
    queryKey: ["vendas", "negocio", leadId],
    enabled: Boolean(leadId),
    staleTime: 15_000,
    queryFn: async () => {
      const resposta = await apiClient.get<{ data: VendaRegistrada[] }>(`/api/v1/vendas?lead_id=${leadId}`);
      // Resposta fora do contrato vira lista vazia, nunca um throw no meio do
      // dossiê ou do painel do Inbox.
      return Array.isArray(resposta?.data) ? resposta.data : [];
    },
  });
}

export interface NovaVenda {
  lead_id?: string;
  contact_id?: string;
  valor_cents: number;
  data: string;
  tags: string[];
  observacao?: string;
}

/**
 * Registrar ou apagar uma venda mexe em vários lugares da tela: a lista do
 * negócio, o painel de vendas (cartões, gráfico, lista), o relatório de
 * negócios ganhos e o VALOR do negócio — que o banco recalcula pela soma das
 * vendas (migration 9450) e o quadro e a página do negócio mostram.
 */
function invalidarVendas(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ["vendas"] });
  void qc.invalidateQueries({ queryKey: ["reports", "painel-de-vendas"] });
  void qc.invalidateQueries({ queryKey: ["reports", "comercial"] });
  void qc.invalidateQueries({ queryKey: ["board"] });
  void qc.invalidateQueries({ queryKey: ["lead"] });
}

export function useRegistrarVenda() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (venda: NovaVenda) =>
      (await apiClient.post<{ data: VendaRegistrada }>("/api/v1/vendas", venda)).data,
    onSuccess: () => invalidarVendas(qc),
    onError: showApiError,
  });
}

export function useApagarVenda() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => apiClient.delete(`/api/v1/vendas/${id}`),
    onSuccess: () => invalidarVendas(qc),
    onError: showApiError,
  });
}
