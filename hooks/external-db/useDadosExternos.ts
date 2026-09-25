"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";

export interface PaginaDeDados {
  colunas: string[];
  linhas: Record<string, unknown>[];
  limite: number;
  offset: number;
}

interface DadosResponse {
  data: PaginaDeDados;
}

export interface ParametrosDeDados {
  connectionId: string;
  schema: string;
  tabela: string;
  limit: number;
  offset: number;
  orderBy?: string;
  orderDesc?: boolean;
  colunas?: string[];
}

export const dadosExternosQueryKey = (p: Omit<ParametrosDeDados, "connectionId"> & { connectionId: string }) =>
  [
    "external-db",
    "connections",
    p.connectionId,
    "tables",
    p.schema,
    p.tabela,
    p.limit,
    p.offset,
    p.orderBy ?? "",
    p.orderDesc ? "desc" : "asc",
    (p.colunas ?? []).join(","),
  ] as const;

export function useDadosExternos(p: ParametrosDeDados, opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: dadosExternosQueryKey(p),
    enabled: opts?.enabled ?? true,
    // Trocar de página mantém a grade anterior enquanto a nova chega — sem isso
    // a tabela pisca para "vazio" entre cliques de paginação.
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("limit", String(p.limit));
      params.set("offset", String(p.offset));
      if (p.orderBy) {
        params.set("order_by", p.orderBy);
        params.set("order_desc", p.orderDesc ? "true" : "false");
      }
      if (p.colunas && p.colunas.length > 0) params.set("colunas", p.colunas.join(","));

      const base = `/api/v1/external-db/connections/${p.connectionId}/tables/${encodeURIComponent(
        p.schema,
      )}/${encodeURIComponent(p.tabela)}`;
      try {
        const res = await apiClient.get<DadosResponse>(`${base}?${params.toString()}`);
        return res.data;
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
  });
}
