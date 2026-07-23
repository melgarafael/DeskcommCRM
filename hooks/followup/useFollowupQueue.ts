"use client";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";

export type FollowupEnrollmentStatus =
  | "active"
  | "waiting_reply"
  | "paused_handoff"
  | "completed"
  | "cancelled"
  | "dead";

export interface FollowupQueueRow {
  source: "enrollment" | "promise";
  id: string;
  contact: { id: string; name: string };
  flow_name: string | null;
  agent_name: string | null;
  node_or_reason: string;
  next_fire_at: string | null;
  status: string;
  detail: string | null;
}

export interface FollowupQueueFilters {
  status?: FollowupEnrollmentStatus;
  pointer_id?: string;
  q?: string;
}

interface ListResponse {
  data: FollowupQueueRow[];
  meta?: { cursor?: string | null; has_more?: boolean };
}

const QUEUE_LIMIT = 20;

export const followupQueueQueryKey = (filters: FollowupQueueFilters) =>
  ["followup", "queue", filters] as const;

export function useFollowupQueue(filters: FollowupQueueFilters = {}) {
  return useInfiniteQuery({
    queryKey: followupQueueQueryKey(filters),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const qs = new URLSearchParams();
      if (filters.status) qs.set("status", filters.status);
      if (filters.pointer_id) qs.set("pointer_id", filters.pointer_id);
      if (filters.q) qs.set("q", filters.q);
      if (pageParam) qs.set("cursor", pageParam);
      qs.set("limit", String(QUEUE_LIMIT));
      try {
        return await apiClient.get<ListResponse>(`/api/v1/ai/followups/queue?${qs.toString()}`);
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
    getNextPageParam: (last) => (last.meta?.has_more && last.meta.cursor ? last.meta.cursor : undefined),
    staleTime: 15_000,
  });
}

export function useCancelFollowupEnrollment() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ["followup", "enrollments", "cancel"],
    mutationFn: async (enrollmentId: string) => {
      const res = await apiClient.post<{ data: { id: string; status: string } }>(
        `/api/v1/ai/followups/enrollments/${enrollmentId}/cancel`,
        {},
      );
      return res.data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["followup", "queue"] });
      toast.success("Follow-up cancelado.");
    },
    onError: (err) => {
      showApiError(err);
    },
  });
}
