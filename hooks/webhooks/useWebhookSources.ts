"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { Pipeline, Stage } from "@/lib/kanban/types";
import type { WebhookFormField } from "@/lib/webhooks/formulario";

export interface WebhookSourceRow {
  id: string;
  organization_id: string;
  name: string;
  path_token: string;
  is_active: boolean;
  authorize_ai_on_capture: boolean;
  kind: string;
  last_received_at: string | null;
  default_pipeline_id: string;
  default_stage_id: string;
  redirect_to: string | null;
  field_map: Record<string, unknown>;
  form_fields: WebhookFormField[];
  has_secret: boolean;
  created_at: string;
  updated_at: string;
  /** Quem mexeu por último (migration 0101). `null` nas fontes anteriores a ela. */
  last_change_actor_kind: string | null;
  last_change_at: string | null;
}

export interface WebhookSourceEvent {
  id: string;
  created_at: string;
  valid_signature: boolean | null;
  payload_parsed: unknown;
  status: string;
}

export interface CreateWebhookSourceInput {
  name: string;
  default_pipeline_id: string;
  default_stage_id: string;
  redirect_to?: string | null;
}

const SOURCES_KEY = ["webhook-sources"];

export function useWebhookSources() {
  return useQuery({
    queryKey: SOURCES_KEY,
    queryFn: async () => apiClient.get<{ data: WebhookSourceRow[] }>("/api/v1/webhook-sources"),
    staleTime: 15_000,
  });
}

export function useCreateWebhookSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateWebhookSourceInput) =>
      apiClient.post<{ data: WebhookSourceRow }>("/api/v1/webhook-sources", input),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SOURCES_KEY });
    },
  });
}

/**
 * `secret` entra pelo MESMO caminho de `is_active` (a rota é um PATCH só), e o
 * corpo é o que sobra depois do `id` — enumerar campo a campo já congelou esta
 * mutação em `{ is_active }` e deixou a tela sem como mandar o segredo.
 * O plaintext passa por aqui de ida e NUNCA volta: a resposta traz só
 * `has_secret`.
 *
 * ⚠️ `gcTime: 0` É PARTE DA PROMESSA, NÃO AFINAÇÃO DE MEMÓRIA.
 *
 * O TanStack guarda as `variables` de cada mutação no `MutationCache` do
 * `QueryClient` — que é singleton da aplicação (`app/providers.tsx`) — pelo
 * `gcTime` padrão de 5 minutos. Com o segredo dentro das `variables`, a tela
 * pode ter descartado o valor e ele seguir legível por `getMutationCache()`
 * durante esses minutos, para qualquer código que rode na página. Zerando,
 * a mutação sai do cache assim que termina, e o único lugar onde o plaintext
 * sobrevive passa a ser o estado local que o componente apaga ao fechar.
 */
export function useUpdateWebhookSource() {
  const qc = useQueryClient();
  return useMutation({
    gcTime: 0,
    mutationFn: async ({
      id,
      ...patch
    }: {
      id: string;
      name?: string;
      is_active?: boolean;
      authorize_ai_on_capture?: boolean;
      secret?: string | null;
      form_fields?: WebhookFormField[];
    }) => apiClient.patch<{ data: WebhookSourceRow }>(`/api/v1/webhook-sources/${id}`, patch),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SOURCES_KEY });
    },
  });
}

export function useDeleteWebhookSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => apiClient.delete(`/api/v1/webhook-sources/${id}`),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SOURCES_KEY });
    },
  });
}

export function useWebhookSourceEvents(sourceId: string | null) {
  return useQuery({
    queryKey: ["webhook-source-events", sourceId],
    queryFn: async () =>
      apiClient.get<{ data: WebhookSourceEvent[] }>(
        `/api/v1/webhook-sources/${sourceId}/events?limit=20`,
      ),
    enabled: !!sourceId,
    refetchInterval: 5_000,
  });
}

export function usePipelines() {
  return useQuery({
    queryKey: ["pipelines"],
    queryFn: async () => apiClient.get<{ data: Pipeline[] }>("/api/v1/pipelines"),
    staleTime: 60_000,
  });
}

export function usePipelineStages(pipelineId: string | null) {
  return useQuery({
    queryKey: ["pipeline-stages", pipelineId],
    queryFn: async () =>
      apiClient.get<{ data: { stages: Stage[] } }>(`/api/v1/pipelines/${pipelineId}/board`),
    enabled: !!pipelineId,
    staleTime: 60_000,
  });
}
