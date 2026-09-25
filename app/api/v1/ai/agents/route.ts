import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/ai/agents  — list agents da org ativa (manager+).
 *                            Inclui kind, priority, published_version_id, paused_at, operation_mode, operation_revision, archived_at,
 *                            e o provider/model da VERSÃO PUBLICADA (ver abaixo).
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
import { mcpAgentDraftRecords } from "@/lib/ai/agents/create-draft";
import { mensagemDoEscopo, validarEscopoDaVersao } from "@/lib/ai/agents/escopo";
import { agentCreateSchema } from "@/lib/ai/guardrails-schema";
import { agentMcpCreateSchema } from "@/lib/ai/agents/validation";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const AGENT_COLUMNS =
  "id, organization_id, name, description, model, system_prompt, is_active, is_default, kind, priority, published_version_id, paused_at, operation_mode, operation_revision, archived_at, config, guardrails, active_kb_version_id, created_at, updated_at";

/**
 * As mesmas colunas MAIS o join da versão publicada — só para a LISTAGEM.
 *
 * Existe porque `useAgentsList` refaz a busca por esta rota depois da primeira
 * pintura: sem o join aqui, o "modelo em vigor" do cartão voltava a ser o id do
 * CADASTRO no primeiro refetch, e o conserto durava um instante. Duas fontes para
 * a mesma lista têm de pedir as mesmas colunas.
 *
 * NÃO entra no POST de propósito: agente recém-criado tem
 * `published_version_id = null` por construção, o embed seria sempre nulo, e
 * pedi-lo ali faz o tipo gerado da linha inserida deixar de resolver (`GenericStringError`).
 */
const AGENT_COLUMNS_COM_VERSAO =
  AGENT_COLUMNS +
  ", versao_publicada:ai_agent_versions!ai_agents_published_version_id_fkey(provider, model)";

const VERSION_COLUMNS =
  "id, organization_id, agent_id, version_number, system_prompt, provider, model, credential_id, tool_ids, trigger_config, channel_session_id, max_steps, token_budget, cost_budget_cents, history_message_window, history_token_window, handoff_keywords, handoff_tool_enabled, cases_enabled, split_messages, split_max_chars, followup, operator_enabled, operator_model, operator_tool_ids, status, published_at, superseded_at, created_at, created_by,pipeline_ids,knowledge_source_ids,provisioning_origin";

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
    .select(AGENT_COLUMNS_COM_VERSAO)
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
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();

  const authz = await requireRole("admin", { requestId, resource: "ai_agents" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user: authUser, org: activeOrg } = authz;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return fail("invalid_request", t("Body JSON inválido."), 400, { requestId });
  }

  const wantsMcp =
    typeof rawBody === "object" &&
    rawBody !== null &&
    ("version" in rawBody || (rawBody as { kind?: unknown }).kind === "mcp_agent");

  const admin = createAdminClient();

  if (wantsMcp) {
    const parsed = agentMcpCreateSchema.safeParse(rawBody);
    if (!parsed.success) {
      return fail("validation_failed", t("Campos inválidos."), 422, {
        requestId,
        details: parsed.error.flatten(),
      });
    }
    const input = parsed.data;

    // Validate scope before the first write; a rejected form leaves no orphan.
    const escopo = await validarEscopoDaVersao(admin, activeOrg.orgId, input.version);
    if (!escopo.ok) return fail("validation_failed", mensagemDoEscopo(escopo), 422, { requestId });
    const records = mcpAgentDraftRecords({ orgId: activeOrg.orgId, userId: authUser.id }, input);
    const { data: agentRow, error: agentError } = await admin
      .from("ai_agents")
      .insert(records.agent)
      .select(AGENT_COLUMNS)
      .single();
    if (agentError || !agentRow)
      return fail("internal_error", "Erro ao criar agent.", 500, { requestId });
    const { data: versionRow, error: versionError } = await admin
      .from("ai_agent_versions")
      .insert(records.version)
      .select(VERSION_COLUMNS)
      .single();
    if (versionError || !versionRow) {
      await admin
        .from("ai_agents")
        .update({ archived_at: new Date().toISOString() })
        .eq("organization_id", activeOrg.orgId)
        .eq("id", agentRow.id);
      return fail("internal_error", t("Erro ao criar versão inicial."), 500, { requestId });
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
    return fail("validation_failed", t("Campos inválidos."), 422, {
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
      model: input.model ?? "anthropic/claude-sonnet-5",
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
