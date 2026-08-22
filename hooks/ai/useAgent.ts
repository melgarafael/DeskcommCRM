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
  /**
   * Provedor e modelo da versão PUBLICADA — o que de fato responde. Vem por join
   * na lista, e é opcional porque nem todo chamador precisa dele. Sem isto, a
   * tela só tinha `ai_agents.model`, que para `mcp_agent` é o valor do cadastro
   * e nunca é atualizado ao publicar.
   */
  versao_publicada?: { provider: string; model: string } | null;
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

interface PublishRagBotResponse {
  data: {
    agent_id: string;
    version_id: string;
    previous_version_id: string | null;
    published_at: string;
  };
}

/**
 * Publica o rascunho de um agente `rag_bot` (POST /publish-rag-bot). Sem isso
 * o "Salvar" do `AgentEditor.tsx` grava o rascunho mas o runtime continua
 * respondendo com a última versão publicada — ver comentário da rota.
 */
export function usePublishRagBotAgent(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ["ai", "agents", id, "publish-rag-bot"],
    mutationFn: async () => {
      const res = await apiClient.post<PublishRagBotResponse>(
        `/api/v1/ai/agents/${id}/publish-rag-bot`,
        {},
      );
      return res.data;
    },
    onError: (err) => {
      showApiError(err);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: agentQueryKey(id) });
      toast.success("Publicado");
    },
  });
}
