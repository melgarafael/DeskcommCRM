"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { AgentPatch } from "@/lib/ai/guardrails-schema";

export interface AgentRow {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  model: string;
  system_prompt: string;
  is_active: boolean;
  is_default: boolean;
  config: Record<string, unknown>;
  guardrails: unknown;
  active_kb_version_id: string | null;
  kind?: "rag_bot" | "mcp_agent" | null;
  priority?: number | null;
  published_version_id?: string | null;
  /** provider/model da VERSÃO PUBLICADA — o que o motor usa (ver lib/ai/agents/modelo-exibido.ts). */
  published_provider?: string | null;
  published_model?: string | null;
  archived_at?: string | null;
  created_at: string;
  updated_at: string;
}

interface SingleResponse {
  data: AgentRow;
}

export const agentQueryKey = (id: string) => ["ai", "agents", id] as const;

export function useAgent(id: string, opts?: { initialData?: AgentRow }) {
  return useQuery({
    queryKey: agentQueryKey(id),
    queryFn: async () => {
      try {
        const res = await apiClient.get<SingleResponse>(`/api/v1/ai/agents/${id}`);
        return res.data;
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
    initialData: opts?.initialData,
    enabled: !!id,
  });
}

export function useUpdateAgent(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ["ai", "agents", id, "update"],
    mutationFn: async (patch: AgentPatch) => {
      const res = await apiClient.patch<SingleResponse>(`/api/v1/ai/agents/${id}`, patch);
      return res.data;
    },
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: agentQueryKey(id) });
      const previous = qc.getQueryData<AgentRow>(agentQueryKey(id));
      if (previous) {
        const optimistic: AgentRow = {
          ...previous,
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.description !== undefined ? { description: patch.description ?? null } : {}),
          ...(patch.is_active !== undefined ? { is_active: patch.is_active } : {}),
          ...(patch.model !== undefined ? { model: patch.model } : {}),
          ...(patch.system_prompt !== undefined ? { system_prompt: patch.system_prompt } : {}),
          ...(patch.config !== undefined
            ? {
                config: {
                  ...(previous.config ?? {}),
                  ...patch.config,
                } as Record<string, unknown>,
              }
            : {}),
          ...(patch.guardrails !== undefined ? { guardrails: patch.guardrails } : {}),
        };
        qc.setQueryData(agentQueryKey(id), optimistic);
      }
      return { previous };
    },
    onError: (err, _patch, context) => {
      if (context?.previous) {
        qc.setQueryData(agentQueryKey(id), context.previous);
      }
      showApiError(err);
    },
    onSuccess: (data) => {
      qc.setQueryData(agentQueryKey(id), data);
      qc.invalidateQueries({ queryKey: ["ai", "agents", "list"] });
      toast.success("Salvo");
    },
  });
}
