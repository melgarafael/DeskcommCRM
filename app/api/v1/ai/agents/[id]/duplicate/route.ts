/**
 * POST /api/v1/ai/agents/:id/duplicate (admin)
 *
 * Spec 10 §4.3. Cria novo agent kind='mcp_agent' clonando o "current draft"
 * (versão draft mais recente; se não houver, clona a published). A nova versão
 * vira v1 status='draft' do novo agent. Nome recebe sufixo " (cópia)".
 *
 * Não copia: published_version_id, archived_at, runs, audit history.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const AGENT_COLUMNS =
  "id, organization_id, name, description, model, system_prompt, is_active, is_default, kind, priority, published_version_id, archived_at, config, guardrails, active_kb_version_id, created_at, updated_at";
const VERSION_COLUMNS =
  "id, organization_id, agent_id, version_number, system_prompt, provider, model, credential_id, tool_ids, trigger_config, channel_session_id, max_steps, token_budget, cost_budget_cents, history_message_window, history_token_window, handoff_keywords, handoff_tool_enabled, status, published_at, superseded_at, created_at, created_by";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) return fail("invalid_request", "id inválido.", 400, { requestId });

  const authz = await requireRole("admin", { requestId, resource: "ai_agents" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org: activeOrg } = authz;

  const admin = createAdminClient();

  const { data: srcAgent } = await admin
    .from("ai_agents")
    .select(AGENT_COLUMNS)
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (!srcAgent) return fail("not_found", "Agent não encontrado.", 404, { requestId });

  // Pick draft mais recente; fallback para a published.
  const { data: srcDraft } = await admin
    .from("ai_agent_versions")
    .select(VERSION_COLUMNS)
    .eq("organization_id", activeOrg.orgId)
    .eq("agent_id", id)
    .eq("status", "draft")
    .order("version_number", { ascending: false })
    .limit(1)
    .maybeSingle();

  let srcVersion = srcDraft;
  if (!srcVersion) {
    const { data: srcPublished } = await admin
      .from("ai_agent_versions")
      .select(VERSION_COLUMNS)
      .eq("organization_id", activeOrg.orgId)
      .eq("agent_id", id)
      .eq("status", "published")
      .limit(1)
      .maybeSingle();
    srcVersion = srcPublished;
  }

  if (!srcVersion) {
    return fail("state_conflict", "Agent não tem versão para duplicar.", 409, { requestId });
  }

  const { data: newAgent, error: newAgentErr } = await admin
    .from("ai_agents")
    .insert({
      organization_id: activeOrg.orgId,
      name: `${srcAgent.name} (cópia)`.slice(0, 120),
      description: srcAgent.description,
      model: srcAgent.model,
      system_prompt: srcAgent.system_prompt,
      is_active: true,
      is_default: false,
      kind: "mcp_agent",
      priority: 0,
      created_by: authUser.id,
    })
    .select(AGENT_COLUMNS)
    .single();

  if (newAgentErr || !newAgent) {
    return fail("internal_error", "Erro ao duplicar agent.", 500, { requestId });
  }

  const { data: newVersion, error: newVErr } = await admin
    .from("ai_agent_versions")
    .insert({
      organization_id: activeOrg.orgId,
      agent_id: newAgent.id,
      version_number: 1,
      system_prompt: srcVersion.system_prompt,
      provider: srcVersion.provider,
      model: srcVersion.model,
      credential_id: srcVersion.credential_id,
      tool_ids: srcVersion.tool_ids,
      trigger_config: srcVersion.trigger_config,
      channel_session_id: srcVersion.channel_session_id,
      max_steps: srcVersion.max_steps,
      token_budget: srcVersion.token_budget,
      cost_budget_cents: srcVersion.cost_budget_cents,
      history_message_window: srcVersion.history_message_window,
      history_token_window: srcVersion.history_token_window,
      handoff_keywords: srcVersion.handoff_keywords,
      handoff_tool_enabled: srcVersion.handoff_tool_enabled,
      status: "draft",
      created_by: authUser.id,
    })
    .select(VERSION_COLUMNS)
    .single();

  if (newVErr || !newVersion) {
    await admin
      .from("ai_agents")
      .update({ archived_at: new Date().toISOString() })
      .eq("id", newAgent.id);
    return fail("internal_error", "Erro ao duplicar versão.", 500, { requestId });
  }

  void audit({
    action: "ai_agent.duplicated",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "ai_agent",
    resourceId: newAgent.id,
    requestId,
    metadata: { source_agent_id: id, source_version_id: srcVersion.id },
  });

  return ok({ agent: newAgent, version: newVersion }, { status: 201, requestId });
}
