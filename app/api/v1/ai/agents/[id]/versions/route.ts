/**
 * GET  /api/v1/ai/agents/:id/versions  — list (manager+).
 * POST /api/v1/ai/agents/:id/versions  — create new draft (admin) = "Save".
 *
 * Spec 10 §4.4. Calcula próximo version_number = max(version_number)+1 com
 * unique constraint cobrindo a corrida; em caso de 23505, tenta novamente uma
 * vez.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { versionCreateSchema } from "@/lib/ai/agents/validation";

export const dynamic = "force-dynamic";

const VERSION_COLUMNS =
  "id, organization_id, agent_id, version_number, system_prompt, provider, model, credential_id, tool_ids, trigger_config, channel_session_id, max_steps, token_budget, cost_budget_cents, history_message_window, history_token_window, handoff_keywords, handoff_tool_enabled, followup, status, published_at, superseded_at, created_at, created_by";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Ctx = { params: Promise<{ id: string }> };

async function assertAgentInOrg(
  agentId: string,
  orgId: string,
): Promise<{ ok: true; kind: string } | { ok: false }> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("ai_agents")
    .select("id, kind, archived_at")
    .eq("id", agentId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (!data || data.archived_at) return { ok: false };
  return { ok: true, kind: (data as { kind: string }).kind };
}

export async function GET(_req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) return fail("invalid_request", "id inválido.", 400, { requestId });

  const authz = await requireRole("manager", { requestId, resource: "ai_agents" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("ai_agent_versions")
    .select(VERSION_COLUMNS)
    .eq("organization_id", activeOrg.orgId)
    .eq("agent_id", id)
    .order("version_number", { ascending: false });

  if (error) return fail("internal_error", "Erro ao listar versions.", 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) return fail("invalid_request", "id inválido.", 400, { requestId });

  const authz = await requireRole("admin", { requestId, resource: "ai_agents" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org: activeOrg } = authz;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400, { requestId });
  }

  const parsed = versionCreateSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", "Campos inválidos.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const v = parsed.data;

  const agentCheck = await assertAgentInOrg(id, activeOrg.orgId);
  if (!agentCheck.ok) {
    return fail("not_found", "Agent não encontrado.", 404, { requestId });
  }

  const admin = createAdminClient();

  // Ordering: insert with retry on 23505 (race com unique(agent_id,version_number)).
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: maxRow } = await admin
      .from("ai_agent_versions")
      .select("version_number")
      .eq("agent_id", id)
      .eq("organization_id", activeOrg.orgId)
      .order("version_number", { ascending: false })
      .limit(1)
      .maybeSingle();

    const nextNumber = (maxRow?.version_number ?? 0) + 1;

    const { data, error } = await admin
      .from("ai_agent_versions")
      .insert({
        organization_id: activeOrg.orgId,
        agent_id: id,
        version_number: nextNumber,
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

    if (!error && data) {
      void audit({
        action: "ai_agent.version_created",
        actorUserId: authUser.id,
        organizationId: activeOrg.orgId,
        resourceType: "ai_agent_version",
        resourceId: data.id,
        requestId,
        metadata: { agent_id: id, version_number: nextNumber },
      });
      return ok(data, { status: 201, requestId });
    }
    if (error?.code !== "23505") {
      return fail("internal_error", "Erro ao criar version.", 500, { requestId });
    }
  }

  return fail("internal_error", "Conflito de versionamento — tente novamente.", 500, { requestId });
}
