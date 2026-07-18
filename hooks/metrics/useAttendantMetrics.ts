"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

export interface FunnelStage {
  stage_id: string;
  stage_name: string;
  position: number;
  count: number;
}

export interface AttendantMetric {
  user_id: string;
  won: number;
  lost: number;
  conversations_handled: number;
  avg_first_response_seconds: number | null;
  name: string | null;
  email: string | null;
}

export interface AttendantMetrics {
  window: { from: string; to: string };
  owner_user_id: string | null;
  funnel: FunnelStage[];
  attendants: AttendantMetric[];
}

/** spec 13 §6 — funil + performance por atendente. `owner` filtra (manager+). */
export function useAttendantMetrics(owner: string | null) {
  const qs = owner ? `?owner_user_id=${encodeURIComponent(owner)}` : "";
  return useQuery({
    queryKey: ["metrics", "attendants", owner ?? "all"],
    queryFn: async () => apiClient.get<{ data: AttendantMetrics }>(`/api/v1/metrics/attendants${qs}`),
    staleTime: 30_000,
  });
}
