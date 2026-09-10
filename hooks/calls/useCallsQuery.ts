"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

export type CallDirection = "outbound" | "inbound";
export type CallStatus = "ringing" | "in_progress" | "completed" | "no_answer" | "busy" | "failed" | "canceled";

export interface CallTranscriptTurn {
  speaker: "agent" | "customer";
  text: string;
  ts: string;
}

export interface CallRow {
  id: string;
  direction: CallDirection;
  status: CallStatus;
  from_number: string;
  to_number: string;
  handled_by: "human" | "ai" | "ai_then_human";
  started_at: string | null;
  answered_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  transcript: CallTranscriptTurn[] | null;
}

export interface CallsFilters {
  direction?: CallDirection;
  status?: CallStatus;
}

interface ListResponse {
  data: CallRow[];
}

export function useCallsQuery(filters: CallsFilters = {}) {
  return useQuery({
    queryKey: ["calls", filters],
    queryFn: async () => {
      const qs = new URLSearchParams();
      if (filters.direction) qs.set("direction", filters.direction);
      if (filters.status) qs.set("status", filters.status);
      const res = await apiClient.get<ListResponse>(`/api/v1/calls?${qs.toString()}`);
      return res.data;
    },
  });
}
