"use client";
/**
 * useAgentRuns — lista runs de um agent (S-13.12).
 *
 * Compõe TanStack Query (GET /api/v1/ai/agents/:id/runs) com Supabase Realtime
 * (`postgres_changes` em `ai_agent_runs` filtrando `agent_id=eq.<id>`). Cada
 * INSERT/UPDATE invalida a query e dispara um toast leve. Toggle `enabled`
 * controla subscribe/unsubscribe pra não vazar canais quando a tab Runs não
 * está ativa.
 */
import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { apiClient } from "@/lib/api/client";
import { useRealtimeChannel } from "@/hooks/realtime/useRealtimeChannel";
import { useT } from "@/hooks/i18n/useT";

export type RunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "aborted"
  | "timeout";

export interface AgentRunRow {
  id: string;
  organization_id: string;
  agent_id: string;
  agent_version_id: string;
  conversation_id: string | null;
  contact_id: string | null;
  channel_session_id: string | null;
  inbound_message_id: string | null;
  outbound_message_id: string | null;
  status: RunStatus;
  abort_reason: string | null;
  error_code: string | null;
  error_message: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_cents: number | null;
  latency_ms: number | null;
  steps_count: number | null;
  tool_calls: unknown;
  /**
   * A pergunta e a resposta de uma execução de TESTE (#4426). `null` nas
   * execuções reais — o motor não guarda texto de conversa em `llm_calls`.
   */
  input_text: string | null;
  output_text: string | null;
  is_dry_run: boolean;
  started_at: string;
  completed_at: string | null;
  created_at: string;
}

interface ListResponse {
  data: AgentRunRow[];
  meta?: { cursor: string | null; has_more: boolean };
}

export const agentRunsKey = (agentId: string) =>
  ["ai", "agents", agentId, "runs"] as const;

export function useAgentRuns(
  agentId: string,
  opts?: { enabled?: boolean; realtime?: boolean; limit?: number },
) {
  const enabled = opts?.enabled ?? true;
  const realtime = opts?.realtime ?? enabled;
  const limit = opts?.limit ?? 25;
  const qc = useQueryClient();
  const t = useT();

  const query = useQuery({
    queryKey: [...agentRunsKey(agentId), limit] as const,
    queryFn: async () => {
      const res = await apiClient.get<ListResponse>(
        `/api/v1/ai/agents/${agentId}/runs?limit=${limit}`,
      );
      return res;
    },
    enabled: !!agentId && enabled,
  });

  const onChange = useCallback(
    (raw: unknown) => {
      const payload = raw as { eventType?: string; new?: AgentRunRow } | null;
      qc.invalidateQueries({ queryKey: agentRunsKey(agentId) });
      if (payload?.eventType === "INSERT" && !payload.new?.is_dry_run) {
        toast.info(t("Nova execução iniciada."));
      }
      if (payload?.eventType === "UPDATE" && payload.new?.status === "completed") {
        toast.success(t("Execução concluída."));
      }
      if (
        payload?.eventType === "UPDATE" &&
        (payload.new?.status === "failed" || payload.new?.status === "aborted")
      ) {
        toast.error(`${t("Execução")} ${payload.new?.status}.`);
      }
    },
    [agentId, qc, t],
  );

  // Pelo hook compartilhado. Este canal foi o PROVADO MORTO pelo @QAVivo: A/B na
  // mesma página, mesma sessão, mesmo socket — o do board (curado) ia com token,
  // este ia sem. Um UPDATE real na tabela, dentro do filtro, não produziu quadro
  // nenhum. Consequência ao usuário: a tela promete acompanhamento ao vivo, e os
  // avisos abaixo NUNCA apareceram — quem abria para ver o agente trabalhando via
  // lista parada e concluía que nada estava acontecendo.
  useRealtimeChannel({
    name: agentId ? `ai-agent-runs-${agentId}` : "ai-agent-runs-disabled",
    postgresChanges: agentId
      ? { event: "*", schema: "public", table: "ai_agent_runs", filter: `agent_id=eq.${agentId}` }
      : undefined,
    onChange,
    enabled: !!agentId && realtime,
  });

  return query;
}
