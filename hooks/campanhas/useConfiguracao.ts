"use client";
/**
 * Os três pedaços da tela de configuração de campanhas: padrões da organização,
 * textos salvos e lista de exclusão.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import type { ConfiguracaoDeCampanhas } from "@/lib/campanhas/configuracao";

export interface TextoSalvo {
  id: string;
  name: string;
  body: string;
  created_at: string;
}

export interface Exclusao {
  id: string;
  contact_id: string | null;
  address_tail: string | null;
  reason: string | null;
  source: string;
  created_at: string;
}

export function useConfiguracaoDeCampanhas() {
  return useQuery({
    queryKey: ["campanhas-configuracao"],
    queryFn: async () =>
      (
        await apiClient.get<{ data: { configuracao: ConfiguracaoDeCampanhas; padrao: ConfiguracaoDeCampanhas } }>(
          "/api/v1/settings/campanhas",
        )
      ).data,
  });
}

export function useSalvarConfiguracao() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (corpo: ConfiguracaoDeCampanhas) =>
      await apiClient.patch("/api/v1/settings/campanhas", corpo),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["campanhas-configuracao"] }),
    onError: (err) => showApiError(err),
  });
}

export function useTextosSalvos() {
  return useQuery({
    queryKey: ["campanhas-textos"],
    queryFn: async () => (await apiClient.get<{ data: TextoSalvo[] }>("/api/v1/campaign-templates")).data,
  });
}

export function useSalvarTexto() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (corpo: { name: string; body: string }) =>
      await apiClient.post("/api/v1/campaign-templates", corpo),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["campanhas-textos"] }),
    onError: (err) => showApiError(err),
  });
}

export function useApagarTexto() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => await apiClient.delete(`/api/v1/campaign-templates/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["campanhas-textos"] }),
    onError: (err) => showApiError(err),
  });
}

export function useExclusoes() {
  return useQuery({
    queryKey: ["campanhas-exclusoes"],
    queryFn: async () =>
      (await apiClient.get<{ data: Exclusao[] }>("/api/v1/campaign-suppressions")).data,
  });
}

export function useExcluirNumero() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (corpo: { address: string; reason?: string | null }) =>
      await apiClient.post("/api/v1/campaign-suppressions", corpo),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["campanhas-exclusoes"] }),
    onError: (err) => showApiError(err),
  });
}

export function useTirarDaExclusao() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => await apiClient.delete(`/api/v1/campaign-suppressions/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["campanhas-exclusoes"] }),
    onError: (err) => showApiError(err),
  });
}
