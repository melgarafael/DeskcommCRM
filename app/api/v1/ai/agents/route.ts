/**
 * GET  /api/v1/ai/agents  — list agents da org ativa (manager+).
 *                            Inclui kind, priority, published_version_id, archived_at.
 *                            Filtro `?include_archived=true` opcional.
 * POST /api/v1/ai/agents  — create agent (admin).
 *                            Mode A (legacy rag_bot): body sem `version` → cria agent
 *                              kind='rag_bot' (mantém compat com Spec 05 / EPIC-06).
 *                            Mode B (mcp_agent S-13.06): body com `version` → cria
 *                              agent kind='mcp_agent' + ai_agent_versions v1 draft
 *                              numa sequência ordenada (rollback se versão falhar).
 *
 * Auth: cookie session. organization_id resolvido do JWT — nunca do body.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { agentCreateSchema } from "@/lib/ai/guardrails-schema";
import { agentMcpCreateSchema } from "@/lib/ai/agents/validation";

export const dynamic = "force-dynamic";

const AGENT_COLUMNS =
  "id, organization_id, name, description, model, system_prompt, is_active, is_default, kind, priority, published_version_id, archived_at, config, guardrails, active_kb_version_id, created_at, updated_at";

const VERSION_COLUMNS =
  "id, organization_id, agent_id, version_number, system_prompt, provider, model, credential_id, tool_ids, trigger_config, channel_session_id, max_steps, token_budget, cost_budget_cents, history_message_window, history_token_window, handoff_keywords, handoff_tool_enabled, followup, status, published_at, superseded_at, created_at, created_by";

// ---------------------------------------------------------------------------
// GET — list
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const authz = await requireRole("manager", { requestId, resource: "ai_agents" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const includeArchived = req.nextUrl.searchParams.get("include_archived") === "true";

  const supabase = await createClient();
  let query = supabase
    .from("ai_agents")
    .select(AGENT_COLUMNS)
    .eq("organization_id", activeOrg.orgId);

  if (!includeArchived) {
    query = query.is("archived_at", null);
  }

  const { data, error } = await query.order("created_at", { ascending: false });
  if (error) return fail("internal_error", "Erro ao listar agents.", 500, { requestId });
  return ok(data ?? [], { requestId });
}

// ---------------------------------------------------------------------------
// POST — create
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const authz = await requireRole("admin", { requestId, resource: "ai_agents" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org: activeOrg } = authz;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400, { requestId });
  }

  const wantsMcp =
    typeof rawBody === "object" &&
    rawBody !== null &&
    ("version" in rawBody || (rawBody as { kind?: unknown }).kind === "mcp_agent");

  const admin = createAdminClient();

  if (wantsMcp) {
    const parsed = agentMcpCreateSchema.safeParse(rawBody);
    if (!parsed.success) {
      return fail("validation_failed", "Campos inválidos.", 422, {
        requestId,
        details: parsed.error.flatten(),
      });
    }
    const input = parsed.data;
    const v = input.version;

    // Insert agent first (no published_version_id yet).
    const { data: agentRow, error: agentErr } = await admin
      .from("ai_agents")
      .insert({
        organization_id: activeOrg.orgId,
        name: input.name,
        description: input.description ?? null,
        model: `${v.provider}/${v.model}`,
        system_prompt: v.system_prompt,
        is_active: true,
        is_default: false,
        kind: "mcp_agent",
        priority: input.priority,
        created_by: authUser.id,
      })
      .select(AGENT_COLUMNS)
      .single();

    if (agentErr || !agentRow) {
      return fail("internal_error", "Erro ao criar agent.", 500, { requestId });
    }

    const { data: versionRow, error: versionErr } = await admin
      .from("ai_agent_versions")
      .insert({
        organization_id: activeOrg.orgId,
        agent_id: agentRow.id,
        version_number: 1,
        system_prompt: v.system_prompt,
        provider: v.provider,
        model: v.model,
        credential_id: v.credential_id,
        tool_ids: v.tool_ids,
        trigger_config: v.trigger_config ?? undefined,
        channel_session_id: v.channel_session_id,
        max_steps: v.max_steps,
        token_budget: v.token_budget,
        cost_budget_cents: v.cost_budget_cents,
        history_message_window: v.history_message_window,
        history_token_window: v.history_token_window,
        handoff_keywords: v.handoff_keywords,
        handoff_tool_enabled: v.handoff_tool_enabled,
        followup: v.followup,
        status: "draft",
        created_by: authUser.id,
      })
      .select(VERSION_COLUMNS)
      .single();

    if (versionErr || !versionRow) {
      // Compensate: agent without v1 is unusable; archive it.
      await admin
        .from("ai_agents")
        .update({ archived_at: new Date().toISOString() })
        .eq("id", agentRow.id);
      return fail("internal_error", "Erro ao criar versão inicial.", 500, {
        requestId,
        details: { agent_rolled_back: true, db_error: versionErr?.message },
      });
    }

    void audit({
      action: "ai_agent.created",
      actorUserId: authUser.id,
      organizationId: activeOrg.orgId,
      resourceType: "ai_agent",
      resourceId: agentRow.id,
      requestId,
      metadata: { kind: "mcp_agent", first_version_id: versionRow.id, priority: input.priority },
    });

    return ok({ agent: agentRow, version: versionRow }, { status: 201, requestId });
  }

  // Legacy path — kind='rag_bot' (default DB constraint).
  const parsed = agentCreateSchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("validation_failed", "Campos inválidos.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const input = parsed.data;

  const { data, error } = await admin
    .from("ai_agents")
    .insert({
      organization_id: activeOrg.orgId,
      name: input.name,
      description: input.description ?? null,
      model: input.model ?? "anthropic/claude-sonnet-4-6",
      system_prompt: input.system_prompt,
      is_active: true,
      is_default: false,
      created_by: authUser.id,
    })
    .select(AGENT_COLUMNS)
    .single();

  if (error || !data) {
    return fail("internal_error", "Erro ao criar agent.", 500, { requestId });
  }
  return ok(data, { status: 201, requestId });
}
