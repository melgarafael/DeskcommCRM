"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

/** Espelha o CHECK de agent_cases.status (migration 0066, spec 15 §7). */
export type CaseStatus = "awaiting_human" | "awaiting_lead" | "resolved" | "escalated" | "cancelled";

/** 'guardrail_autofallback' = o caso foi aberto pelo sistema (spec 14) sem a IA pedir explicitamente. */
export type CaseSource = "agent" | "guardrail_autofallback";

/** Espelha o CHECK de agent_case_events.kind. */
export type CaseEventKind =
  | "opened"
  | "human_replied"
  | "lead_asked"
  | "lead_provided"
  | "lead_unresponsive"
  | "resolved"
  | "escalated"
  | "cancelled";

export type CaseActorKind = "agent" | "human" | "system" | "lead";

/** A ação que o humano toma ao responder um caso — POST .../reply. */
export type CaseHumanAction = "resolved" | "need_lead_info" | "escalate";

export interface CaseListItem {
  id: string;
  title: string;
  summary: string;
  blocker: string;
  status: CaseStatus;
  opened_at: string;
  conversation_id: string;
  contact_name: string | null;
  contact_phone: string | null;
}

export interface CaseListData {
  cases: CaseListItem[];
  open_count: number;
}

export interface CaseEvent {
  id: string;
  kind: CaseEventKind;
  actor_kind: CaseActorKind;
  actor_user_id: string | null;
  human_action: CaseHumanAction | null;
  body: string | null;
  created_at: string;
}

export interface CaseDetailData {
  id: string;
  title: string;
  summary: string;
  blocker: string;
  status: CaseStatus;
  source: CaseSource;
  opened_at: string;
  closed_at: string | null;
  conversation_id: string;
  contact_name: string | null;
  contact_phone: string | null;
  events: CaseEvent[];
}

/** Lista de casos humanos (spec 15 §9). Polling 60s — casos nascem no worker. */
export function useCases(status: "open" | "resolved" = "open") {
  return useQuery({
    queryKey: ["ai-cases", status],
    refetchInterval: 60_000,
    queryFn: () =>
      apiClient.get<{ data: CaseListData }>(`/api/v1/ai/cases?status=${status}`).then((r) => r.data),
  });
}

export function useCase(id: string | null) {
  return useQuery({
    queryKey: ["ai-case", id],
    enabled: id !== null,
    refetchInterval: 60_000,
    queryFn: () => apiClient.get<{ data: CaseDetailData }>(`/api/v1/ai/cases/${id}`).then((r) => r.data),
  });
}

export function useReplyCase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action, body }: { id: string; action: CaseHumanAction; body: string }) =>
      apiClient
        .post<{ data: { status: CaseStatus; delivery?: "service_stale" } }>(`/api/v1/ai/cases/${id}/reply`, { action, body })
        .then((r) => r.data),
    onSettled: (_data, _err, vars) => {
      qc.invalidateQueries({ queryKey: ["ai-case", vars.id] });
      qc.invalidateQueries({ queryKey: ["ai-cases"] });
    },
  });
}
