"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import type { PacingKnobs } from "@/lib/agent-engine/pacing/defaults";
import type { ChannelKnobsRow, PacingKnobsUpdate } from "@/lib/ai/pacing-knobs";

export interface PacingSessionLite {
  id: string;
  waha_session_name: string | null;
  display_name: string | null;
  phone_number: string | null;
  status: string | null;
  daily_message_limit: number | null;
}

export interface PacingKnobsItem {
  channel_session: PacingSessionLite;
  effective: PacingKnobs;
  overrides: ChannelKnobsRow | null;
  defaults: PacingKnobs;
  bounds: {
    intervalMaxMs: number;
    hourLastStart: number;
    hourEnd: number;
    daily_limit: { min: number; max: number };
  };
}

/** Knobs anti-ban por conexão (Operação Visível F2ii) — GET /api/v1/ai/pacing. */
export function usePacingKnobs(enabled = true) {
  return useQuery({
    queryKey: ["pacing-knobs"],
    enabled,
    queryFn: () =>
      apiClient.get<{ data: { items: PacingKnobsItem[] } }>("/api/v1/ai/pacing").then((r) => r.data),
  });
}

export function useUpdatePacingKnobs() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PacingKnobsUpdate) => apiClient.put("/api/v1/ai/pacing", body),
    onSettled: () => qc.invalidateQueries({ queryKey: ["pacing-knobs"] }),
  });
}
