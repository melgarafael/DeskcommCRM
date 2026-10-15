"use client";

import { useQuery } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import type { Fonte } from "@/lib/external-db/fontes";
import type { ModoDeFontes } from "@/lib/external-db/types";

export interface FontesDaConexao {
  source_mode: ModoDeFontes;
  sources: Fonte[];
}

interface FontesResponse {
  data: FontesDaConexao;
}

export const fontesQueryKey = (connectionId: string) =>
  ["external-db", "connections", connectionId, "sources"] as const;

/** A lista salva (qualquer autenticado lê; só o admin grava). */
export function useFontesDaConexao(connectionId: string) {
  return useQuery({
    queryKey: fontesQueryKey(connectionId),
    queryFn: async () => {
      try {
        const res = await apiClient.get<FontesResponse>(`/api/v1/external-db/connections/${connectionId}/sources`);
        return res.data;
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
  });
}

/** Troca o modo E a lista inteira de uma vez (a rota é idempotente: o mesmo corpo grava o mesmo estado). */
export async function salvarFontes(connectionId: string, corpo: FontesDaConexao): Promise<FontesDaConexao> {
  const res = await apiClient.put<FontesResponse>(`/api/v1/external-db/connections/${connectionId}/sources`, {
    source_mode: corpo.source_mode,
    sources: corpo.sources,
  });
  return res.data;
}
