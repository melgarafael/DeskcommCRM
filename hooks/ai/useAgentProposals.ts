"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

export interface ProposalRow {
  id: string;
  run_id: string;
  dataset: string;
  type: "playbook_bullet" | "golden_case" | "reentry_trigger";
  target: string;
  content: string;
  evidence: Record<string, unknown>;
  proposed_at: string;
  applied_at: string | null;
  applied_version_id: string | null;
  applied_by: string | null;
}

/** Propostas do flywheel na tela do agente (Operação Visível F3). */
export function useAgentProposals(agentId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["agent-proposals", agentId],
    enabled,
    queryFn: () =>
      apiClient
        .get<{ data: { items: ProposalRow[] } }>(
          `/api/v1/ai/agents/${agentId}/proposals?status=all`,
        )
        .then((r) => r.data),
  });
}

export function useApplyProposal(agentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (proposalId: string) =>
      apiClient.post(`/api/v1/ai/agents/${agentId}/proposals/${proposalId}/apply`, {}),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["agent-proposals", agentId] });
      void qc.invalidateQueries({ queryKey: ["agent-versions", agentId] });
    },
  });
}
