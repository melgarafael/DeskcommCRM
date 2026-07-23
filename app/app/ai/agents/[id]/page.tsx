import { notFound, redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";
import type { AgentRow } from "@/hooks/ai/useAgent";
import type { AgentVersionRow } from "@/hooks/ai/useAgentVersions";
import type { CredentialRow } from "@/hooks/ai/useCredentials";

import { AgentEditorClient } from "./_client";
import { AgentTabs } from "./_components/AgentTabs";
import type { ChannelSessionLite } from "./_components/AgentForm";

export const dynamic = "force-dynamic";

const AGENT_COLUMNS =
  "id, organization_id, name, description, model, system_prompt, is_active, is_default, kind, priority, published_version_id, archived_at, config, guardrails, active_kb_version_id, created_at, updated_at";

const VERSION_COLUMNS =
  "id, organization_id, agent_id, version_number, system_prompt, provider, model, credential_id, tool_ids, trigger_config, channel_session_id, max_steps, token_budget, cost_budget_cents, history_message_window, history_token_window, handoff_keywords, handoff_tool_enabled, followup, status, published_at, superseded_at, created_at, created_by";

const CREDENTIAL_COLUMNS =
  "id, organization_id, provider, label, api_key_last4, validated_at, validation_error, models_available, is_active, created_by, created_at, updated_at";

export default async function AgentEditorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }

  const supabase = await createClient();
  const { data: agentRow } = await supabase
    .from("ai_agents")
    .select(AGENT_COLUMNS)
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();

  if (!agentRow) notFound();

  const agent = agentRow as unknown as AgentRow;
  const readOnly = ROLE_RANK[activeOrg.role] < ROLE_RANK.admin;

  // Caminho legado: rag_bot continua usando o editor pré-EPIC-13.
  if ((agent.kind ?? "rag_bot") !== "mcp_agent") {
    return (
      <div className="flex h-full flex-col gap-6 p-6">
        <AgentEditorClient agentId={agent.id} initialData={agent} readOnly={readOnly} />
      </div>
    );
  }

  // mcp_agent: busca versions + lookups.
  const [versionsRes, credentialsRes, channelRes] = await Promise.all([
    supabase
      .from("ai_agent_versions")
      .select(VERSION_COLUMNS)
      .eq("organization_id", activeOrg.orgId)
      .eq("agent_id", id)
      .order("version_number", { ascending: false }),
    supabase
      .from("ai_provider_credentials_safe")
      .select(CREDENTIAL_COLUMNS)
      .eq("organization_id", activeOrg.orgId),
    supabase
      .from("channel_sessions")
      .select("id, display_name, status, phone_number, waha_session_name")
      .eq("organization_id", activeOrg.orgId),
  ]);

  const versions = (versionsRes.data ?? []) as unknown as AgentVersionRow[];
  const credentials = (credentialsRes.data ?? []) as unknown as CredentialRow[];
  const channelSessions: ChannelSessionLite[] = (channelRes.data ?? []).map((c) => ({
    id: c.id as string,
    display_name: (c.display_name as string | null) ?? (c.waha_session_name as string),
    status: c.status as string,
    phone_number: (c.phone_number as string | null) ?? null,
  }));

  const draft =
    versions
      .filter((v) => v.status === "draft")
      .reduce<AgentVersionRow | null>(
        (a, b) => (a && a.version_number > b.version_number ? a : b),
        null,
      );
  const published = versions.find((v) => v.status === "published") ?? null;

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <AgentTabs
        agent={agent}
        draft={draft}
        published={published}
        versions={versions}
        credentials={credentials}
        channelSessions={channelSessions}
        readOnly={readOnly}
      />
    </div>
  );
}
