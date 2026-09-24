"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";

export interface TemplateSlotView {
  key: string;
  expects: string;
  /** Rótulo humano do endereço: "corpo", "cabeçalho", "card 2 › cabeçalho". */
  onde: string;
  /** A chave deste valor em `template_values` e em `savedValues` (`header:1`). */
  valueKey: string;
}

/** Texto de um componente, inteiro e uma vez só — a UI marca os `{{n}}`. */
export interface TemplatePreview {
  onde: string;
  text: string;
}

export interface TemplateView {
  name: string;
  language: string;
  status: string;
  category: string | null;
  rejectedReason: string | null;
  qualityScore: string | null;
  parameterFormat: string;
  contractHash: string;
  syncedAt: string;
  /** DERIVADOS do template pela API — nunca digitados, nunca contados à mão. */
  slots: TemplateSlotView[];
  previews: TemplatePreview[];
  /** Links de mídia salvos no modelo — o painel da janela fechada pré-preenche com eles. */
  savedValues: Record<string, string>;
}

export interface TemplatesPayload {
  /** `null` = canal oficial não conectado. Distinto de "conectado e sem template". */
  waba: string | null;
  templates: TemplateView[];
}

export interface SyncCounts {
  inserted: number;
  updated: number;
  unchanged: number;
  disabled: number;
}

export function useTemplates() {
  return useQuery({
    queryKey: ["channel-templates"],
    queryFn: async () => apiClient.get<{ data: TemplatesPayload }>("/api/v1/channels/templates"),
    staleTime: 30_000,
  });
}

export function useSyncTemplates() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => apiClient.post<{ data: SyncCounts }>("/api/v1/channels/templates", {}),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["channel-templates"] });
    },
  });
}

/**
 * Grava (ou esquece, com string vazia) o link de mídia do modelo. Invalida
 * também a lista do painel da janela fechada, que lê a mesma rota com outra
 * chave: sem isso o link salvo aqui só apareceria na conversa depois do
 * `staleTime`.
 */
export function useSaveTemplateValues() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { name: string; language: string; values: Record<string, string> }) =>
      apiClient.patch<{ data: { savedValues: Record<string, string> } }>(
        "/api/v1/channels/templates",
        args,
      ),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["channel-templates"] });
      qc.invalidateQueries({ queryKey: ["templates-da-conversa"] });
    },
  });
}
