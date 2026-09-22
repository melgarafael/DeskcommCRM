"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { PedidoComercial } from "@/lib/schemas/pedidos";
import { historicoDeCompra, type HistoricoCompra } from "@/lib/comercial/radar-compras";

export interface ResumoLead {
  id: string;
  title: string;
  status: string;
  value_cents: number | null;
  updated_at: string;
}

export interface ResumoDemanda {
  id: string;
  aberta_em: string;
  origem: string;
  estado: string;
  proximo_passo: string | null;
}

export interface Resumo360 {
  pedidos: PedidoComercial[];
  historico: HistoricoCompra | null;
  leads: ResumoLead[];
  demandas: ResumoDemanda[];
  leadsAbertos: number;
}

/**
 * Resumo 360°: pedidos + histórico de recompra (calculado dos pedidos reais
 * via `historicoDeCompra`) + negócios + demandas abertas. Uma chave de cache
 * por contato, compartilhada pelas abas do dossiê.
 */
export function useResumo360(contactId: string) {
  const pedidos = useQuery({
    queryKey: ["contato", contactId, "pedidos"],
    queryFn: () =>
      apiClient
        .get<{ data: PedidoComercial[] }>(`/api/v1/commercial-orders?contact_id=${contactId}`)
        .then((r) => (Array.isArray(r.data) ? r.data : [])),
  });
  const summary = useQuery({
    queryKey: ["contato", contactId, "crm-summary"],
    queryFn: () =>
      apiClient
        .get<{ data: { leads: ResumoLead[]; demandas: ResumoDemanda[] } }>(
          `/api/v1/contacts/${contactId}/crm-summary`,
        )
        .then((r) => r.data),
  });

  const lista = pedidos.data ?? [];
  const hoje = new Date().toISOString().slice(0, 10);
  const historico =
    lista.length > 0
      ? historicoDeCompra(
          lista.map((p) => ({
            id: p.id,
            contact_id: p.contact_id,
            total_cents: p.total_cents,
            status: p.status,
            origem: p.origem,
            dia: p.created_at.slice(0, 10),
          })),
          contactId,
          hoje,
        )
      : null;

  const leads = summary.data?.leads ?? [];
  const resumo: Resumo360 | null =
    pedidos.data !== undefined && summary.data !== undefined
      ? {
          pedidos: lista,
          historico,
          leads,
          demandas: summary.data.demandas ?? [],
          leadsAbertos: leads.filter((l) => l.status === "open").length,
        }
      : null;

  return {
    resumo,
    isLoading: pedidos.isLoading || summary.isLoading,
    isError: pedidos.isError || summary.isError,
    refetch: () => {
      void pedidos.refetch();
      void summary.refetch();
    },
  };
}
