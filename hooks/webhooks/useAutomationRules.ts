"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type {
  CreateAutomationRuleInput,
  UpdateAutomationRuleInput,
} from "@/lib/schemas/webhooks";

export interface AutomationRuleRow {
  id: string;
  organization_id: string;
  name: string;
  trigger_event: string;
  conditions: Array<{ field: string; op: "eq" | "neq" | "contains"; value: string }>;
  actions: Array<{ type: string; config: Record<string, unknown> }>;
  is_active: boolean;
  last_run_at: string | null;
  run_count: number;
  created_at: string;
  updated_at: string;
}

const RULES_KEY = ["automation-rules"];

export function useAutomationRules() {
  return useQuery({
    queryKey: RULES_KEY,
    queryFn: async () => apiClient.get<{ data: AutomationRuleRow[] }>("/api/v1/automation-rules"),
    staleTime: 15_000,
  });
}

export function useCreateAutomationRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateAutomationRuleInput) =>
      apiClient.post<{ data: AutomationRuleRow }>("/api/v1/automation-rules", input),
    onError: showApiError,
    onSuccess: () => qc.invalidateQueries({ queryKey: RULES_KEY }),
  });
}

export function useUpdateAutomationRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...input }: UpdateAutomationRuleInput & { id: string }) =>
      apiClient.patch<{ data: AutomationRuleRow }>(`/api/v1/automation-rules/${id}`, input),
    onError: showApiError,
    onSuccess: () => qc.invalidateQueries({ queryKey: RULES_KEY }),
  });
}

export function useDeleteAutomationRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => apiClient.delete(`/api/v1/automation-rules/${id}`),
    onError: showApiError,
    onSuccess: () => qc.invalidateQueries({ queryKey: RULES_KEY }),
  });
}

export interface AutomationRuleRunActionResult {
  type: string;
  status: "success" | "failed" | "skipped" | "postponed";
  error?: string;
  detail?: Record<string, unknown>;
}

export interface AutomationRuleRunRow {
  id: string;
  organization_id: string;
  rule_id: string;
  event_id: string | null;
  status: "success" | "failed" | "partial";
  actions_result: AutomationRuleRunActionResult[];
  error: string | null;
  created_at: string;
  automation_rules: { name: string } | null;
}

const RUNS_KEY = ["automation-rule-runs"];

export function useAutomationRuns() {
  return useQuery({
    queryKey: RUNS_KEY,
    queryFn: async () =>
      apiClient.get<{ data: AutomationRuleRunRow[] }>("/api/v1/automation-rules/runs?limit=50"),
    staleTime: 15_000,
  });
}

export function useResendAutomationRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (runId: string) =>
      apiClient.post<{ data: AutomationRuleRunRow }>(
        `/api/v1/automation-rules/runs/${runId}/resend`,
        undefined,
      ),
    onError: showApiError,
    onSuccess: () => qc.invalidateQueries({ queryKey: RUNS_KEY }),
  });
}
