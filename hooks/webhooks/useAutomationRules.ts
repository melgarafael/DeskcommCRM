"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type {
  CreateAutomationRuleInput,
  UpdateAutomationRuleInput,
} from "@/lib/schemas/webhooks";
import type { Conditions } from "@/lib/automation/conditions";

export interface AutomationRuleRow {
  id: string;
  organization_id: string;
  name: string;
  trigger_event: string;
  conditions: Conditions;
  actions: Array<{ type: string; config: Record<string, unknown> }>;
  /**
   * O que o gatilho precisa saber além do nome (#989, migration 0268). Só o
   * gatilho de data do funil usa (`{ pipeline_id, campo, dias }`); nas regras
   * anteriores à coluna, e nas dos outros gatilhos, é o objeto vazio.
   */
  trigger_config: Record<string, unknown> | null;
  is_active: boolean;
  last_run_at: string | null;
  run_count: number;
  created_at: string;
  updated_at: string;
  /** Quem mexeu por último (migration 0101). `null` nas regras anteriores a ela. */
  last_change_actor_kind: string | null;
  last_change_at: string | null;
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

/** Espelha o CHECK de `automation_rule_runs.status` (migrations 0038 e 0175). */
export type AutomationRunStatus = "success" | "failed" | "partial" | "adiado";

export interface AutomationRuleRunRow {
  id: string;
  organization_id: string;
  rule_id: string;
  event_id: string | null;
  /**
   * Espelha o CHECK de `automation_rule_runs.status` — `adiado` entrou na
   * migration 0175 (a espera é um estado; sem ele a tela não mostrava NADA
   * enquanto a regra aguardava a janela de envio).
   */
  status: AutomationRunStatus;
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
