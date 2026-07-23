"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

export type Provider = "anthropic" | "openai" | "google";

export interface AgentVersionRow {
  id: string;
  organization_id: string;
  agent_id: string;
  version_number: number;
  system_prompt: string;
  provider: Provider;
  model: string;
  credential_id: string;
  tool_ids: string[];
  trigger_config: Record<string, unknown> | null;
  channel_session_id: string;
  max_steps: number;
  token_budget: number;
  cost_budget_cents: number;
  history_message_window: number;
  history_token_window: number;
  handoff_keywords: string[];
  handoff_tool_enabled: boolean;
  followup: { enabled: boolean; flow_pointer_ids: string[] };
  status: "draft" | "published" | "superseded" | "archived";
  published_at: string | null;
  superseded_at: string | null;
  created_at: string;
  created_by: string | null;
}

interface ListResponse {
  data: AgentVersionRow[];
}

export const agentVersionsKey = (agentId: string) =>
  ["ai", "agents", agentId, "versions"] as const;

export function useAgentVersions(agentId: string, opts?: { initialData?: AgentVersionRow[] }) {
  return useQuery({
    queryKey: agentVersionsKey(agentId),
    queryFn: async () => {
      const res = await apiClient.get<ListResponse>(`/api/v1/ai/agents/${agentId}/versions`);
      return res.data;
    },
    initialData: opts?.initialData,
    enabled: !!agentId,
  });
}

export function pickLatestDraft(versions: AgentVersionRow[]): AgentVersionRow | null {
  const drafts = versions.filter((v) => v.status === "draft");
  if (drafts.length === 0) return null;
  return drafts.reduce((a, b) => (a.version_number > b.version_number ? a : b));
}

export function pickPublished(versions: AgentVersionRow[]): AgentVersionRow | null {
  return versions.find((v) => v.status === "published") ?? null;
}
