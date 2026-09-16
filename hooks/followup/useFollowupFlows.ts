"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiClient } from "@/lib/api/client";
import type { FollowupFlowSurface } from "@/lib/followup/api-schemas";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";

export type FollowupFlowStatus = "draft" | "active" | "disabled";

export interface FollowupFlowPointerRow {
  id: string;
  name: string;
  status: FollowupFlowStatus;
  active_version_id: string | null;
  handoff_policy: string;
  updated_at: string;
}

interface ListResponse {
  data: FollowupFlowPointerRow[];
}

interface SingleResponse {
  data: FollowupFlowPointerRow;
}

export const followupFlowsListQueryKey = ["followup", "flows", "list"] as const;

export function useFollowupFlows(opts?: {
  initialData?: FollowupFlowPointerRow[];
  /** Recorta a listagem por superfície (`atendimento` = tela de fluxos de atendimento). */
  surface?: FollowupFlowSurface;
}) {
  const surface = opts?.surface;
  return useQuery({
    queryKey: [...followupFlowsListQueryKey, surface ?? "all"],
    queryFn: async () => {
      try {
        const url = surface
          ? `/api/v1/ai/followup-flows?surface=${encodeURIComponent(surface)}`
          : "/api/v1/ai/followup-flows";
        const res = await apiClient.get<ListResponse>(url);
        return res.data;
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
    initialData: opts?.initialData,
  });
}

export function useCreateFollowupFlow() {
  const t = useT();
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ["followup", "flows", "create"],
    mutationFn: async (input: { name: string; surface?: FollowupFlowSurface }) => {
      const res = await apiClient.post<SingleResponse>("/api/v1/ai/followup-flows", {
        name: input.name,
        ...(input.surface ? { surface: input.surface } : {}),
      });
      return res.data;
    },
    onSuccess: () => {
      // Invalidate (não setQueryData): a lista agora é por superfície, e o hook
      // de criação não sabe qual recorte está na tela. Refetch resolve os dois.
      void qc.invalidateQueries({ queryKey: followupFlowsListQueryKey });
      toast.success(t("Fluxo criado."));
    },
    onError: (err) => {
      showApiError(err);
    },
  });
}
