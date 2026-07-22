"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { FlowGraph } from "@/lib/followup/graph-schema";
import { followupFlowsListQueryKey, type FollowupFlowStatus } from "./useFollowupFlows";

export interface FollowupFlowDetailRow {
  id: string;
  name: string;
  status: FollowupFlowStatus;
  active_version_id: string | null;
  draft_graph: FlowGraph | null;
  handoff_policy: "pause" | "cancel" | "allow";
  trigger_config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  versions_count: number;
  previous_version_id: string | null;
}

interface SingleResponse {
  data: FollowupFlowDetailRow;
}

export function followupFlowQueryKey(id: string) {
  return ["followup", "flows", "detail", id] as const;
}

export function useFollowupFlow(id: string, opts?: { initialData?: FollowupFlowDetailRow }) {
  return useQuery({
    queryKey: followupFlowQueryKey(id),
    queryFn: async () => {
      try {
        const res = await apiClient.get<SingleResponse>(`/api/v1/ai/followup-flows/${id}`);
        return res.data;
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
    initialData: opts?.initialData,
  });
}

/** PATCH draft_graph — "Salvar". Errors handled by the caller (dirty-state UI), no toast noise. */
export function useSaveFollowupFlowDraft(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (draft_graph: FlowGraph) => {
      const res = await apiClient.patch<SingleResponse>(`/api/v1/ai/followup-flows/${id}`, {
        draft_graph,
      });
      return res.data;
    },
    onSuccess: (updated) => {
      qc.setQueryData<FollowupFlowDetailRow>(followupFlowQueryKey(id), (prev) =>
        prev ? { ...prev, ...updated } : prev,
      );
      toast.success("Rascunho salvo.");
    },
    onError: (err) => showApiError(err),
  });
}

/**
 * POST publish. Deliberately NO onError toast here: a 422 validation_failed
 * carries `details.errors[].node_id` that the caller renders anchored to the
 * offending node — a generic toast would duplicate/bury that signal.
 */
export function usePublishFollowupFlow(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await apiClient.post<SingleResponse>(`/api/v1/ai/followup-flows/${id}/publish`, {});
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: followupFlowQueryKey(id) });
      qc.invalidateQueries({ queryKey: followupFlowsListQueryKey });
      toast.success("Fluxo publicado.");
    },
  });
}

export function useDisableFollowupFlow(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await apiClient.post<{ data: { id: string; status: string } }>(
        `/api/v1/ai/followup-flows/${id}/disable`,
        {},
      );
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: followupFlowQueryKey(id) });
      qc.invalidateQueries({ queryKey: followupFlowsListQueryKey });
      toast.success("Fluxo desativado.");
    },
    onError: (err) => showApiError(err),
  });
}

export function useRollbackFollowupFlow(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (version_id: string) => {
      const res = await apiClient.post<SingleResponse>(`/api/v1/ai/followup-flows/${id}/rollback`, {
        version_id,
      });
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: followupFlowQueryKey(id) });
      toast.success("Fluxo revertido para a versão anterior.");
    },
    onError: (err) => showApiError(err),
  });
}

export function useUpdateHandoffPolicy(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (handoff_policy: "pause" | "cancel" | "allow") => {
      const res = await apiClient.patch<SingleResponse>(`/api/v1/ai/followup-flows/${id}`, {
        handoff_policy,
      });
      return res.data;
    },
    onSuccess: (updated) => {
      qc.setQueryData<FollowupFlowDetailRow>(followupFlowQueryKey(id), (prev) =>
        prev ? { ...prev, ...updated } : prev,
      );
      toast.success("Política de handoff atualizada.");
    },
    onError: (err) => showApiError(err),
  });
}
