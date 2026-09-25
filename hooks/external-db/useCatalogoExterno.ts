"use client";

import { useQuery } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";

export interface ColunaExterna {
  nome: string;
  tipo: string;
  nulavel: boolean;
  posicao: number;
}

export interface TabelaExterna {
  schema: string;
  nome: string;
  tipo: "tabela" | "view" | "outro";
  colunas: ColunaExterna[];
  chavePrimaria: string[];
  estimativaLinhas: number;
}

interface CatalogoResponse {
  data: { tabelas: TabelaExterna[] };
}

export const catalogoExternoQueryKey = (connectionId: string) =>
  ["external-db", "connections", connectionId, "schemas"] as const;

export function useCatalogoExterno(connectionId: string) {
  return useQuery({
    queryKey: catalogoExternoQueryKey(connectionId),
    queryFn: async () => {
      try {
        const res = await apiClient.get<CatalogoResponse>(
          `/api/v1/external-db/connections/${connectionId}/schemas`,
        );
        return res.data.tabelas;
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
  });
}
