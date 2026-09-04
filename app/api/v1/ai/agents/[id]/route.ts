/**
 * GET    /api/v1/ai/agents/:id  — fetch um agent (manager+)
 * PATCH  /api/v1/ai/agents/:id  — atualiza campos (admin)
 * DELETE /api/v1/ai/agents/:id  — soft delete via is_active=false (admin); 409 se is_default
 *
 * organization_id sempre vem do JWT da sessão, nunca do body/path inseguro.
 * Audit: trigger trg_ai_agents_audit grava em audit_log automaticamente.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  agentPatchSchema,
  AGENT_CONFIG_DEFAULTS,
  type AgentConfig,
} from "@/lib/ai/guardrails-schema";

export const dynamic = "force-dynamic";

const AGENT_COLUMNS =
  "id, organization_id, name, description, model, system_prompt, is_active, is_default, kind, priority, published_version_id, archived_at, config, guardrails, active_kb_version_id, created_at, updated_at";

type RouteCtx = { params: Promise<{ id: string }> };

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  if (!UUID_RX.test(id)) {
    return fail("invalid_request", "id inválido.", 400, { requestId });
  }

  const authz = await requireRole("manager", { requestId, resource: "ai_agents" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("ai_agents")
    .select(AGENT_COLUMNS)
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();

  if (error) {
    return fail("internal_error", "Erro ao buscar agent.", 500, { requestId });
  }
  if (!data) {
    return fail("not_found", "Agent não encontrado.", 404, { requestId });
  }

  return ok(data, { requestId });
}

// ---------------------------------------------------------------------------
// PATCH
// ---------------------------------------------------------------------------

export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  if (!UUID_RX.test(id)) {
    return fail("invalid_request", "id inválido.", 400, { requestId });
  }

  const authz = await requireRole("admin", { requestId, resource: "ai_agents" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400, { requestId });
  }

  // Extract priority (mcp_agent-only) before strict-schema parse so we don't
  // reject as unknown key. Validate range manually.
  let priorityPatch: number | null = null;
  if (rawBody !== null && typeof rawBody === "object" && "priority" in rawBody) {
    const p = (rawBody as { priority?: unknown }).priority;
    if (
      typeof p !== "number" ||
      !Number.isInteger(p) ||
      p < 0 ||
      p > 1000
    ) {
      return fail("validation_failed", "priority inválido (0..1000).", 422, { requestId });
    }
    priorityPatch = p;
    delete (rawBody as Record<string, unknown>).priority;
  }

  const parsed = agentPatchSchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("validation_failed", "Campos inválidos.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const patch = parsed.data;
  const admin = createAdminClient();

  // Carrega o agent atual (filtrando org explicitamente — service role bypassa RLS).
  const { data: existing, error: loadErr } = await admin
    .from("ai_agents")
    .select(AGENT_COLUMNS)
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();

  if (loadErr) {
    return fail("internal_error", "Erro ao carregar agent.", 500, { requestId });
  }
  if (!existing) {
    return fail("not_found", "Agent não encontrado.", 404, { requestId });
  }

  // ─── CONTEÚDO DE VERSÃO PUBLICADA NÃO SE EDITA PELO CADASTRO ───────────
  //
  // `system_prompt` e `model` existem nas DUAS tabelas. Quando há versão
  // publicada, é a versão que o motor lê (`agent-config.ts:123`) — gravar em
  // `ai_agents` devolvia 200, a tela mostrava o texto novo, e o agente seguia
  // respondendo ao cliente com o prompt anterior. Sem erro em lugar nenhum.
  //
  // O banco já sabia disso: `fn_ai_agent_version_content_immutable` recusa
  // mudar conteúdo de versão publicada com esta mesma frase. Faltava a rota
  // seguir a mesma regra — falhar FECHADO, e ensinar o caminho.
  //
  // Sem versão publicada, `ai_agents.system_prompt` É a fonte legítima (é o que
  // `workers/ai-response-worker.ts` lê), e continua editável. (issue #456)
  const CONTEUDO_DA_VERSAO = ["system_prompt", "model"] as const;
  if (existing.published_version_id != null) {
    const barrados = CONTEUDO_DA_VERSAO.filter((c) => patch[c] !== undefined);
    if (barrados.length > 0) {
      return fail(
        "state_conflict",
        `Este agente tem uma versão publicada, e é ela que o atendimento executa. ` +
          `Mudança de conteúdo (${barrados.join(", ")}) = versão draft nova; publica. ` +
          `Edite pela aba Modelo do editor de versões.`,
        409,
        { requestId, details: { campos: barrados, published_version_id: existing.published_version_id } },
      );
    }
  }

  // Build UPDATE payload. Para `config`, faz merge preservando defaults.
  const update: Record<string, unknown> = {};

  if (patch.name !== undefined) update.name = patch.name;
  if (patch.description !== undefined) update.description = patch.description;
  if (patch.is_active !== undefined) update.is_active = patch.is_active;
  if (patch.model !== undefined) update.model = patch.model;
  if (patch.system_prompt !== undefined) update.system_prompt = patch.system_prompt;
  if (patch.guardrails !== undefined) update.guardrails = patch.guardrails;

  if (priorityPatch !== null) update.priority = priorityPatch;

  if (patch.config !== undefined) {
    const currentConfigRaw = (existing.config ?? {}) as Record<string, unknown>;
    const merged: AgentConfig = {
      ...AGENT_CONFIG_DEFAULTS,
      ...currentConfigRaw,
      ...patch.config,
    } as AgentConfig;
    update.config = merged;
  }

  if (Object.keys(update).length === 0) {
    return ok(existing, { requestId });
  }

  const { data: updated, error: updErr } = await admin
    .from("ai_agents")
    .update(update)
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .select(AGENT_COLUMNS)
    .single();

  if (updErr || !updated) {
    return fail("internal_error", "Erro ao atualizar agent.", 500, { requestId });
  }

  return ok(updated, { requestId });
}

// ---------------------------------------------------------------------------
// DELETE — soft delete (is_active=false). 409 se is_default=true.
// ---------------------------------------------------------------------------

export async function DELETE(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  if (!UUID_RX.test(id)) {
    return fail("invalid_request", "id inválido.", 400, { requestId });
  }

  const authz = await requireRole("admin", { requestId, resource: "ai_agents" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org: activeOrg } = authz;

  const admin = createAdminClient();

  const { data: existing, error: loadErr } = await admin
    .from("ai_agents")
    .select("id, is_default, is_active, kind, archived_at")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();

  if (loadErr) {
    return fail("internal_error", "Erro ao carregar agent.", 500, { requestId });
  }
  if (!existing) {
    return fail("not_found", "Agent não encontrado.", 404, { requestId });
  }
  if (existing.is_default) {
    return fail(
      "state_conflict",
      "Não é possível desativar o agent default da organização.",
      409,
      { requestId },
    );
  }

  // mcp_agent: soft archive via archived_at + clear published_version_id (pausa
  // dispatcher). rag_bot legado mantém comportamento is_active=false.
  const isMcp = existing.kind === "mcp_agent";
  const patch: Record<string, unknown> = isMcp
    ? { archived_at: new Date().toISOString(), published_version_id: null, is_active: false }
    : { is_active: false };

  const { error: updErr } = await admin
    .from("ai_agents")
    .update(patch)
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId);

  if (updErr) {
    return fail("internal_error", "Erro ao desativar agent.", 500, { requestId });
  }

  void audit({
    action: "ai_agent.archived",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "ai_agent",
    resourceId: id,
    requestId,
    metadata: { kind: existing.kind },
  });

  return ok({ id, archived: isMcp, is_active: false }, { requestId });
}
