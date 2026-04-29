"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { UsagePayload } from "@/lib/ai/usage/aggregate";

export interface AiUsageFilters {
  agent_id?: string;
  invocation_kind?: string;
  from?: string;
  to?: string;
}

interface SingleResponse {
  data: UsagePayload;
}

export const aiUsageQueryKey = (filters: AiUsageFilters) =>
  ["ai", "usage", filters] as const;

function toQs(filters: AiUsageFilters): string {
  const sp = new URLSearchParams();
  if (filters.agent_id) sp.set("agent_id", filters.agent_id);
  if (filters.invocation_kind) sp.set("invocation_kind", filters.invocation_kind);
  if (filters.from) sp.set("from", filters.from);
  if (filters.to) sp.set("to", filters.to);
  const qs = sp.toString();
  return qs ? `?${qs}` : "";
}

export function useAiUsage(filters: AiUsageFilters) {
  return useQuery({
    queryKey: aiUsageQueryKey(filters),
    queryFn: async () => {
      try {
        const res = await apiClient.get<SingleResponse>(
          `/api/v1/ai/usage${toQs(filters)}`,
        );
        return res.data;
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
    staleTime: 60_000,
  });
}
