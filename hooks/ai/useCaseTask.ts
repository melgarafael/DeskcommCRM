"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import type { CaseTaskAction, CaseTaskFields } from "@/lib/ai/case-task";

export type CaseTaskView = CaseTaskFields & {
  assigned_to_me?: boolean;
  can_reassign?: boolean;
  lead_title?: string | null;
  purchase_candidates?: Array<{ id: string; title: string }>;
};

export function useCaseTask(caseId: string) {
  return useQuery({
    queryKey: ["ai-case-task", caseId],
    refetchInterval: 15_000,
    queryFn: () =>
      apiClient.get<{ data: CaseTaskView }>(`/api/v1/ai/cases/${caseId}/task`).then((r) => r.data),
  });
}

export function useActOnCaseTask(caseId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CaseTaskAction) =>
      apiClient
        .post<{ data: CaseTaskView }>(`/api/v1/ai/cases/${caseId}/task`, input)
        .then((r) => r.data),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["ai-case-task", caseId] });
      qc.invalidateQueries({ queryKey: ["ai-case", caseId] });
      qc.invalidateQueries({ queryKey: ["ai-cases"] });
    },
  });
}
