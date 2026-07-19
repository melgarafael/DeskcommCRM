"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { Pipeline, Stage } from "@/lib/kanban/types";

export interface WebhookSourceRow {
  id: string;
  organization_id: string;
  name: string;
  path_token: string;
  is_active: boolean;
  kind: string;
  last_received_at: string | null;
  default_pipeline_id: string;
  default_stage_id: string;
  redirect_to: string | null;
  field_map: Record<string, unknown>;
  has_secret: boolean;
  created_at: string;
  updated_at: string;
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

export function useUpdateWebhookSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, is_active }: { id: string; is_active: boolean }) =>
      apiClient.patch<{ data: WebhookSourceRow }>(`/api/v1/webhook-sources/${id}`, { is_active }),
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
