"use client";

import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";

import type { TabelaExterna } from "./useCatalogoExterno";

interface CatalogoCompletoResponse {
  data: { tabelas: TabelaExterna[] };
}

export const catalogoCompletoQueryKey = (connectionId: string) =>
  ["external-db", "connections", connectionId, "catalog"] as const;

/**
 * O catálogo COMPLETO do banco de origem (só o admin pode; a chamada vai AO VIVO
 * ao banco do cliente). Só roda quando `enabled` — o painel o liga quando está
 * aberto e a pessoa pode editar. Sem toast de erro: o painel mostra a própria
 * mensagem com "Tentar de novo", e a lista salva continua visível.
 */
export function useCatalogoCompleto(connectionId: string, opts: { enabled: boolean }) {
  return useQuery({
    queryKey: catalogoCompletoQueryKey(connectionId),
    enabled: opts.enabled,
    staleTime: 60_000,
    retry: false,
    queryFn: async () => {
      const res = await apiClient.get<CatalogoCompletoResponse>(
        `/api/v1/external-db/connections/${connectionId}/catalog`,
      );
      return res.data.tabelas;
    },
  });
}
