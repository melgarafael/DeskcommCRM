import { requireSupportWrite } from "@/lib/impersonate/support";
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
import { mensagemDoEscopo, validarEscopoDaVersao } from "@/lib/ai/agents/escopo";
import { versionCreateSchema } from "@/lib/ai/agents/validation";
import { lerAmbiente } from "@/lib/instalacao/ambiente";

export const dynamic = "force-dynamic";

const VERSION_COLUMNS =
  "id, organization_id, agent_id, version_number, system_prompt, provider, model, credential_id, tool_ids, trigger_config, channel_session_id, max_steps, token_budget, cost_budget_cents, history_message_window, history_token_window, handoff_keywords, handoff_tool_enabled, cases_enabled, split_messages, split_max_chars, followup, operator_enabled, operator_model, operator_tool_ids, status, published_at, superseded_at, created_at, created_by,pipeline_ids,knowledge_source_ids,provisioning_origin";

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
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

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

    // ⚠️ FALHA FECHADA: `credential_id: null` significa "usa a chave da
    // instalação". Se ela não existir para este provedor, a versão seria
    // publicada para morrer em toda mensagem — e o dono só descobriria com o
    // primeiro cliente. O schema valida FORMA; quem conhece o ambiente do
    // servidor é esta rota.
    if (v.credential_id === null && lerAmbiente().chavesDeProvedor[v.provider] !== true) {
      return fail(
        "credential_required",
        `Esta instalação não tem chave de ${v.provider} no ambiente. Cadastre uma chave em IA › Credenciais ou escolha outra empresa de inteligência artificial.`,
        422,
        { requestId },
      );
    }

    // O escopo aponta para coisas que EXISTEM nesta organização. Sem esta
    // conferência, um id de outra organização (ou de um material apagado) entra
    // no array, a versão é publicada, e o assistente não acha nada — sem erro,
    // com a tela mostrando a marcação como se estivesse valendo.
    const escopo = await validarEscopoDaVersao(admin, activeOrg.orgId, {
      pipeline_ids: v.pipeline_ids,
      knowledge_source_ids: v.knowledge_source_ids,
    });
    if (!escopo.ok) {
      return fail("validation_failed", mensagemDoEscopo(escopo), 422, { requestId });
    }

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
        cases_enabled: v.cases_enabled,
        split_messages: v.split_messages,
        split_max_chars: v.split_max_chars,
        followup: v.followup,
        // Mesmo descarte silencioso da rota de criação de agente: o corpo aceita
        // e o INSERT ignorava. Criar uma versão nova pela API com escopo ou
        // acervo produzia uma versão vazia, com 201.
        operator_enabled: v.operator_enabled,
        operator_model: v.operator_model,
        operator_tool_ids: v.operator_tool_ids,
        pipeline_ids: v.pipeline_ids,
        knowledge_source_ids: v.knowledge_source_ids,
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
