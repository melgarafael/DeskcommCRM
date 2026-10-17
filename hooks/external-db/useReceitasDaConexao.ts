"use client";

import { useQuery } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import type { InstanciaDeReceita } from "@/lib/external-db/receitas/tipos";

export interface ReceitasDaConexao {
  receitas: InstanciaDeReceita[];
}

interface ReceitasResponse {
  data: ReceitasDaConexao;
}

export const receitasQueryKey = (connectionId: string) =>
  ["external-db", "connections", connectionId, "receitas"] as const;

/** As instâncias de receita da conexão (qualquer autenticado lê; só o admin grava). */
export function useReceitasDaConexao(connectionId: string) {
  return useQuery({
    queryKey: receitasQueryKey(connectionId),
    queryFn: async () => {
      try {
        const res = await apiClient.get<ReceitasResponse>(
          `/api/v1/external-db/connections/${connectionId}/recipes`,
        );
        return res.data;
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
  });
}

/** Troca a lista inteira de instâncias de uma vez (a rota é idempotente). */
export async function salvarReceitas(
  connectionId: string,
  receitas: InstanciaDeReceita[],
): Promise<ReceitasDaConexao> {
  const res = await apiClient.put<ReceitasResponse>(
    `/api/v1/external-db/connections/${connectionId}/recipes`,
    { receitas },
  );
  return res.data;
}

interface PreviewResponse {
  data: {
    instancia: { id: string; receita: string; rotulo: string };
    colunas: string[];
    linhas: Record<string, unknown>[];
    linhas_devolvidas: number;
    truncado?: boolean;
  };
}

export async function previewReceita(
  connectionId: string,
  instancia_id: string,
  busca: unknown,
): Promise<PreviewResponse["data"]> {
  const res = await apiClient.post<PreviewResponse>(
    `/api/v1/external-db/connections/${connectionId}/recipes/preview`,
    { instancia_id, busca },
  );
  return res.data;
}

interface SugerirCamposACFResponse {
  data: {
    receita: string;
    prefixo: string;
    post_type: string;
    meta_keys: string[];
    mapeamento_sugerido: Record<string, string | null>;
    aviso?: string;
  };
}

/** Pede ao servidor os meta_key mais frequentes de um post_type (só acf-imoveis). */
export async function sugerirCamposACF(
  connectionId: string,
  prefixo: string,
  post_type: string,
): Promise<SugerirCamposACFResponse["data"]> {
  const res = await apiClient.post<SugerirCamposACFResponse>(
    `/api/v1/external-db/connections/${connectionId}/recipes/suggest`,
    { receita: "acf-imoveis", prefixo, post_type },
  );
  return res.data;
}

interface SugerirCamposTabelaDiretaResponse {
  data: {
    receita: string;
    tabela: string;
    colunas: string[];
    mapeamento_sugerido: Record<string, string | null>;
    aviso?: string;
  };
}

/** Pede ao servidor as colunas de uma tabela (só tabela-direta). */
export async function sugerirCamposTabelaDireta(
  connectionId: string,
  tabela: string,
): Promise<SugerirCamposTabelaDiretaResponse["data"]> {
  const res = await apiClient.post<SugerirCamposTabelaDiretaResponse>(
    `/api/v1/external-db/connections/${connectionId}/recipes/suggest`,
    { receita: "tabela-direta", tabela },
  );
  return res.data;
}

interface SugerirCamposJetEngineResponse {
  data: {
    receita: string;
    prefixo: string;
    ccts: Array<{
      tabela: string;
      colunas: string[];
      mapeamento: Record<string, string | null>;
    }>;
  };
}

/** Pede ao servidor as tabelas jet_cct_* de um prefixo (só jetengine-imoveis). */
export async function sugerirCamposJetEngine(
  connectionId: string,
  prefixo: string,
): Promise<SugerirCamposJetEngineResponse["data"]> {
  const res = await apiClient.post<SugerirCamposJetEngineResponse>(
    `/api/v1/external-db/connections/${connectionId}/recipes/suggest`,
    { receita: "jetengine-imoveis", prefixo },
  );
  return res.data;
}
