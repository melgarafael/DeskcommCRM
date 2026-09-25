"use client";

import { useQuery } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";

/** Espelha a `_safe` view: sem as três colunas cifradas, jamais. */
export interface ConexaoExternaRow {
  id: string;
  organization_id: string;
  label: string;
  host: string;
  port: number;
  database_name: string;
  username: string;
  ssl_mode: string;
  enabled: boolean;
  max_rows: number;
  max_filters: number;
  max_response_bytes: number;
  last_tested_at: string | null;
  last_test_ok: boolean | null;
  last_test_error: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

interface ListResponse {
  data: ConexaoExternaRow[];
}

interface OneResponse {
  data: ConexaoExternaRow;
}

export const conexoesExternasQueryKey = ["external-db", "connections", "list"] as const;

export function useConexoesExternas(opts?: { initialData?: ConexaoExternaRow[] }) {
  return useQuery({
    queryKey: conexoesExternasQueryKey,
    queryFn: async () => {
      try {
        const res = await apiClient.get<ListResponse>("/api/v1/external-db/connections");
        return res.data;
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
    initialData: opts?.initialData,
  });
}

export interface EntradaDeConexao {
  label: string;
  host: string;
  port: number;
  database_name: string;
  username: string;
  password: string;
  ssl_mode: string;
  enabled: boolean;
  max_rows: number;
  max_filters: number;
  max_response_bytes: number;
}

export type PatchDeConexao = Partial<Omit<EntradaDeConexao, "password">> & {
  password?: string;
};

export async function criarConexao(input: EntradaDeConexao): Promise<ConexaoExternaRow> {
  const res = await apiClient.post<OneResponse>("/api/v1/external-db/connections", input);
  return res.data;
}

export async function atualizarConexao(
  id: string,
  patch: PatchDeConexao,
): Promise<ConexaoExternaRow> {
  const res = await apiClient.patch<OneResponse>(`/api/v1/external-db/connections/${id}`, patch);
  return res.data;
}

export async function removerConexao(id: string): Promise<void> {
  await apiClient.delete<unknown>(`/api/v1/external-db/connections/${id}`);
}

export interface ResultadoDeTesteDaConexao {
  ok: boolean;
  erro?: string;
  testado_em?: string;
}

export async function testarConexao(id: string): Promise<ResultadoDeTesteDaConexao> {
  const res = await apiClient.post<{ data: ResultadoDeTesteDaConexao }>(
    `/api/v1/external-db/connections/${id}/test`,
    {},
  );
  return res.data;
}
