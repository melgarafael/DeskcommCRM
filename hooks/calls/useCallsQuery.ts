"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";

export type CallDirection = "outbound" | "inbound";
export type CallStatus = "ringing" | "in_progress" | "completed" | "no_answer" | "busy" | "failed" | "canceled";

export interface CallTranscriptTurn {
  speaker: "agent" | "customer";
  text: string;
  ts: string;
}

export interface CallContact {
  id: string;
  name: string | null;
  display_name: string | null;
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
  /** Identificador de ligações — null quando o número não bate com nenhum contato. */
  contact: CallContact | null;
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

export interface DialCallInput {
  toNumber: string;
  contactId?: string;
  leadId?: string;
  /** Fase 1 do discador: só "ai" está disponível — o atendente ainda não tem
   * ponte de áudio pro navegador para falar ele mesmo (ver ariClient.ts). */
  mode?: "ai";
}

interface DialCallResponse {
  data: { callId: string; channelId: string };
}

/** Discador — aciona a IA pra ligar pro número/contato/lead informado. */
export function useDialCall() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (input: DialCallInput) =>
      apiClient.post<DialCallResponse>("/api/v1/calls", {
        toNumber: input.toNumber,
        contactId: input.contactId,
        leadId: input.leadId,
        mode: input.mode ?? "ai",
      }),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["calls"] });
    },
  });
}
