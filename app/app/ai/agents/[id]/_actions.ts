"use server";
/**
 * Server actions para o editor de agent (Spec 12 §3 / S-13.11).
 *
 * `saveAgentDraftAction`  — admin. Cria/atualiza version draft.
 *   Estratégia: se já existir uma draft pro agent, PATCH nela (evita explosão
 *   de versões para edits incrementais). Senão, POST cria nova draft com
 *   version_number = max+1.
 *
 * `publishAgentAction`    — admin. Publica via `fn_publish_ai_agent_version`.
 *
 * `createMcpAgentAction`  — admin. Cria agent kind=mcp_agent + v1 draft (rota
 *   POST /api/v1/ai/agents Modo B).
 *
 * Todos os actions devolvem o objeto de resultado simples `{ ok, data?, error?, message? }`
 * porque a UI consome direto. Audit é emitido pelas rotas REST onde aplicável;
 * aqui chamamos os handlers internos para reusar a lógica.
 */
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";

import { audit } from "@/lib/audit";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  agentMcpCreateSchema,
  versionCreateSchema,
  versionPatchSchema,
  PUBLISH_ERROR_CODES,
} from "@/lib/ai/agents/validation";
import { publishAgentVersion } from "@/lib/ai/agents/publish";
import { VALID_TOOL_IDS } from "@/lib/mcp/tools";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VERSION_COLUMNS =
  "id, organization_id, agent_id, version_number, system_prompt, provider, model, credential_id, tool_ids, trigger_config, channel_session_id, max_steps, token_budget, cost_budget_cents, history_message_window, history_token_window, handoff_keywords, handoff_tool_enabled, followup, status, published_at, superseded_at, created_at, created_by";

type ActionResult<T = void> =
  | { ok: true; data?: T }
  | { ok: false; error: string; message?: string; details?: unknown };

async function ensureAdmin() {
  const authUser = await loadAuthUser();
  if (!authUser) return { ok: false as const, error: "unauthenticated" };
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) return { ok: false as const, error: "forbidden_tenant" };
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    return { ok: false as const, error: "forbidden_role" };
  }
  return { ok: true as const, authUser, activeOrg };
}

// ---------------------------------------------------------------------------
// saveAgentDraftAction
// ---------------------------------------------------------------------------

export async function saveAgentDraftAction(
  agentId: string,
  payload: unknown,
): Promise<ActionResult<{ version_id: string; version_number: number }>> {
  if (!UUID_RX.test(agentId)) return { ok: false, error: "invalid_request" };
  const guard = await ensureAdmin();
  if (!guard.ok) return guard;
  const { authUser, activeOrg } = guard;

  const parsed = versionCreateSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      error: "validation_failed",
      details: parsed.error.flatten(),
    };
  }
  const v = parsed.data;
  const requestId = randomUUID();
  const admin = createAdminClient();

  // Sanity: o agent existe e é da org? não está arquivado?
  const { data: agent } = await admin
    .from("ai_agents")
    .select("id, kind, archived_at")
    .eq("id", agentId)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (!agent) return { ok: false, error: "not_found" };
  if (agent.archived_at) return { ok: false, error: "agent_archived" };

  // Procura draft existente (latest por version_number)
  const { data: existingDraft } = await admin
    .from("ai_agent_versions")
    .select("id, version_number")
    .eq("organization_id", activeOrg.orgId)
    .eq("agent_id", agentId)
    .eq("status", "draft")
    .order("version_number", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existingDraft) {
    // PATCH na draft existente — não infla a sequência de versions.
    const patchValidated = versionPatchSchema.safeParse(payload);
    if (!patchValidated.success) {
      return { ok: false, error: "validation_failed", details: patchValidated.error.flatten() };
    }
    const update: Record<string, unknown> = { ...patchValidated.data };
    const { data: updated, error } = await admin
      .from("ai_agent_versions")
      .update(update)
      .eq("id", existingDraft.id)
      .eq("organization_id", activeOrg.orgId)
      .select(VERSION_COLUMNS)
      .single();

    if (error || !updated) {
      return { ok: false, error: "internal_error", message: error?.message };
    }

    void audit({
      action: "ai_agent.version_updated",
      actorUserId: authUser.id,
      organizationId: activeOrg.orgId,
      resourceType: "ai_agent_version",
      resourceId: existingDraft.id,
      requestId,
      metadata: { agent_id: agentId, fields: Object.keys(update) },
    });

    revalidatePath(`/app/ai/agents/${agentId}`);
    return {
      ok: true,
      data: {
        version_id: existingDraft.id,
        version_number: (existingDraft as { version_number: number }).version_number,
      },
    };
  }

  // Cria draft v(max+1) com retry em 23505.
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: maxRow } = await admin
      .from("ai_agent_versions")
      .select("version_number")
      .eq("agent_id", agentId)
      .eq("organization_id", activeOrg.orgId)
      .order("version_number", { ascending: false })
      .limit(1)
      .maybeSingle();
    const nextNumber = (maxRow?.version_number ?? 0) + 1;

    const { data: created, error } = await admin
      .from("ai_agent_versions")
      .insert({
        organization_id: activeOrg.orgId,
        agent_id: agentId,
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
      .select("id, version_number")
      .single();

    if (!error && created) {
      void audit({
        action: "ai_agent.version_created",
        actorUserId: authUser.id,
        organizationId: activeOrg.orgId,
        resourceType: "ai_agent_version",
        resourceId: created.id,
        requestId,
        metadata: { agent_id: agentId, version_number: created.version_number },
      });
      revalidatePath(`/app/ai/agents/${agentId}`);
      return { ok: true, data: { version_id: created.id, version_number: created.version_number } };
    }
    if (error?.code !== "23505") {
      return { ok: false, error: "internal_error", message: error?.message };
    }
  }
  return { ok: false, error: "internal_error", message: "Conflito de versionamento." };
}

// ---------------------------------------------------------------------------
// publishAgentAction
// ---------------------------------------------------------------------------

export async function publishAgentAction(
  agentId: string,
  versionId: string,
): Promise<ActionResult<{ version_id: string; previous_version_id: string | null }>> {
  if (!UUID_RX.test(agentId) || !UUID_RX.test(versionId)) {
    return { ok: false, error: "invalid_request" };
  }
  const guard = await ensureAdmin();
  if (!guard.ok) return guard;
  const { authUser, activeOrg } = guard;

  const requestId = randomUUID();
  const admin = createAdminClient();

  // Tool ids check (espelha publish/route.ts).
  const valid = new Set<string>(VALID_TOOL_IDS as readonly string[]);
  const { data: targetV } = await admin
    .from("ai_agent_versions")
    .select("id, agent_id, tool_ids")
    .eq("id", versionId)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (!targetV || targetV.agent_id !== agentId) {
    return { ok: false, error: "version_not_found" };
  }
  const tools = (targetV.tool_ids ?? []) as string[];
  const invalid = tools.filter((t) => !valid.has(t));
  if (invalid.length > 0) {
    return { ok: false, error: "tool_id_invalid", details: { invalid } };
  }

  const result = await publishAgentVersion(admin, {
    orgId: activeOrg.orgId,
    agentId,
    versionId,
  });

  if (!result.ok) {
    if (PUBLISH_ERROR_CODES.has(result.code as string)) {
      return { ok: false, error: result.code };
    }
    return { ok: false, error: "internal_error" };
  }

  void admin
    .from("event_log")
    .insert({
      organization_id: activeOrg.orgId,
      event_type: "ai_agent.published",
      payload: {
        agent_id: result.agent_id,
        version_id: result.version_id,
        previous_version_id: result.previous_version_id,
        published_at: result.published_at,
      },
    })
    .then(({ error }) => {
      if (error) console.error("[saveAgentDraftAction/publish] event_log error", error.message);
    });

  void audit({
    action: "ai_agent.published",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "ai_agent",
    resourceId: agentId,
    requestId,
    metadata: { version_id: result.version_id, previous_version_id: result.previous_version_id },
  });

  revalidatePath(`/app/ai/agents/${agentId}`);
  revalidatePath("/app/ai/agents");
  return {
    ok: true,
    data: { version_id: result.version_id, previous_version_id: result.previous_version_id },
  };
}

// ---------------------------------------------------------------------------
// revertToVersionAction
// ---------------------------------------------------------------------------
//
// Cria uma nova draft idêntica a `versionId` e a publica imediatamente. O
// fluxo é: clone → INSERT draft v(max+1) → publishAgentVersion. Audit
// `ai_agent.reverted` registra a ponta original. Mesma validação de tools do
// publish original (espelha publish/route.ts).

export async function revertToVersionAction(
  agentId: string,
  versionId: string,
): Promise<
  ActionResult<{
    new_version_id: string;
    new_version_number: number;
    previous_version_id: string | null;
  }>
> {
  if (!UUID_RX.test(agentId) || !UUID_RX.test(versionId)) {
    return { ok: false, error: "invalid_request" };
  }
  const guard = await ensureAdmin();
  if (!guard.ok) return guard;
  const { authUser, activeOrg } = guard;

  const requestId = randomUUID();
  const admin = createAdminClient();

  const { data: agent } = await admin
    .from("ai_agents")
    .select("id, archived_at")
    .eq("id", agentId)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (!agent) return { ok: false, error: "not_found" };
  if (agent.archived_at) return { ok: false, error: "agent_archived" };

  const { data: source } = await admin
    .from("ai_agent_versions")
    .select(VERSION_COLUMNS)
    .eq("id", versionId)
    .eq("organization_id", activeOrg.orgId)
    .eq("agent_id", agentId)
    .maybeSingle();
  if (!source) return { ok: false, error: "version_not_found" };

  // Espelha tool_id check do publish.
  const tools = ((source as { tool_ids: string[] | null }).tool_ids ?? []) as string[];
  const valid = new Set<string>(VALID_TOOL_IDS as readonly string[]);
  const invalid = tools.filter((t) => !valid.has(t));
  if (invalid.length > 0) {
    return { ok: false, error: "tool_id_invalid", details: { invalid } };
  }

  // Cria draft idêntica com retry em 23505 (race no version_number).
  type SourceRow = {
    system_prompt: string;
    provider: string;
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
  };
  const src = source as unknown as SourceRow;

  let createdId: string | null = null;
  let createdNumber: number | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: maxRow } = await admin
      .from("ai_agent_versions")
      .select("version_number")
      .eq("agent_id", agentId)
      .eq("organization_id", activeOrg.orgId)
      .order("version_number", { ascending: false })
      .limit(1)
      .maybeSingle();
    const nextNumber = (maxRow?.version_number ?? 0) + 1;

    const { data: created, error } = await admin
      .from("ai_agent_versions")
      .insert({
        organization_id: activeOrg.orgId,
        agent_id: agentId,
        version_number: nextNumber,
        system_prompt: src.system_prompt,
        provider: src.provider,
        model: src.model,
        credential_id: src.credential_id,
        tool_ids: src.tool_ids,
        trigger_config: src.trigger_config ?? undefined,
        channel_session_id: src.channel_session_id,
        max_steps: src.max_steps,
        token_budget: src.token_budget,
        cost_budget_cents: src.cost_budget_cents,
        history_message_window: src.history_message_window,
        history_token_window: src.history_token_window,
        handoff_keywords: src.handoff_keywords,
        handoff_tool_enabled: src.handoff_tool_enabled,
        status: "draft",
        created_by: authUser.id,
      })
      .select("id, version_number")
      .single();

    if (!error && created) {
      createdId = created.id;
      createdNumber = created.version_number;
      break;
    }
    if (error?.code !== "23505") {
      return { ok: false, error: "internal_error", message: error?.message };
    }
  }
  if (!createdId || createdNumber == null) {
    return { ok: false, error: "internal_error", message: "Conflito de versionamento." };
  }

  const result = await publishAgentVersion(admin, {
    orgId: activeOrg.orgId,
    agentId,
    versionId: createdId,
  });
  if (!result.ok) {
    // Rollback: remove draft órfã para não deixar lixo (a draft só existe
    // como veículo do publish; sem publish, não tem razão de ser).
    await admin
      .from("ai_agent_versions")
      .delete()
      .eq("id", createdId)
      .eq("organization_id", activeOrg.orgId)
      .eq("status", "draft");
    if (PUBLISH_ERROR_CODES.has(result.code as string)) {
      return { ok: false, error: result.code };
    }
    return { ok: false, error: "internal_error" };
  }

  void admin
    .from("event_log")
    .insert({
      organization_id: activeOrg.orgId,
      event_type: "ai_agent.published",
      payload: {
        agent_id: result.agent_id,
        version_id: result.version_id,
        previous_version_id: result.previous_version_id,
        published_at: result.published_at,
      },
    })
    .then(({ error }) => {
      if (error) console.error("[revertToVersionAction/event_log] error", error.message);
    });

  void audit({
    action: "ai_agent.reverted",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "ai_agent",
    resourceId: agentId,
    requestId,
    metadata: {
      from_version_id: versionId,
      new_version_id: createdId,
      new_version_number: createdNumber,
      previous_version_id: result.previous_version_id,
    },
  });

  revalidatePath(`/app/ai/agents/${agentId}`);
  revalidatePath("/app/ai/agents");
  return {
    ok: true,
    data: {
      new_version_id: createdId,
      new_version_number: createdNumber,
      previous_version_id: result.previous_version_id,
    },
  };
}

// ---------------------------------------------------------------------------
// createMcpAgentAction (página /ai/agents/new)
// ---------------------------------------------------------------------------

export async function createMcpAgentAction(
  payload: unknown,
): Promise<ActionResult<{ agent_id: string }>> {
  const guard = await ensureAdmin();
  if (!guard.ok) return guard;
  const { authUser, activeOrg } = guard;

  const parsed = agentMcpCreateSchema.safeParse(payload);
  if (!parsed.success) {
    return { ok: false, error: "validation_failed", details: parsed.error.flatten() };
  }

  const requestId = randomUUID();
  const admin = createAdminClient();

  // Cria agent kind='mcp_agent' + v1 draft. Compensa rollback se versão falhar.
  const { data: agentRow, error: agentErr } = await admin
    .from("ai_agents")
    .insert({
      organization_id: activeOrg.orgId,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      model: parsed.data.version.model,
      system_prompt: parsed.data.version.system_prompt,
      kind: "mcp_agent",
      priority: parsed.data.priority,
      is_active: false,
      is_default: false,
      created_by: authUser.id,
    })
    .select("id")
    .single();

  if (agentErr || !agentRow) {
    return { ok: false, error: "internal_error", message: agentErr?.message };
  }

  const v = parsed.data.version;
  const { error: versionErr } = await admin.from("ai_agent_versions").insert({
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
    status: "draft",
    created_by: authUser.id,
  });

  if (versionErr) {
    // Compensação — archiva o agent recém criado para evitar lixo.
    await admin
      .from("ai_agents")
      .update({ archived_at: new Date().toISOString() })
      .eq("id", agentRow.id)
      .eq("organization_id", activeOrg.orgId);
    return { ok: false, error: "internal_error", message: versionErr.message };
  }

  void audit({
    action: "ai_agent.created",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "ai_agent",
    resourceId: agentRow.id,
    requestId,
    metadata: { kind: "mcp_agent" },
  });

  revalidatePath("/app/ai/agents");
  return { ok: true, data: { agent_id: agentRow.id } };
}
