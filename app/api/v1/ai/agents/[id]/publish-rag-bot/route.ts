/**
 * POST /api/v1/ai/agents/:id/publish-rag-bot
 *
 * Publica o rascunho de um agente `rag_bot` — o editor legado
 * (`components/ai/AgentEditor.tsx`) só salva em `ai_agents`, mas o runtime lê
 * `system_prompt`/`provider`/`model` da versão publicada. Sem esta rota, editar
 * pela tela não tem efeito nenhum (medido: fica respondendo com o prompt do
 * bootstrap inicial, em silêncio). Ver `supabase/migrations/*_0168_*.sql`.
 *
 * Atomic flip via fn_publish_rag_bot_version:
 *   - versão publicada atual → 'superseded'
 *   - versão nova (system_prompt/provider/model do rascunho, resto copiado da
 *     atual) → 'published'
 *   - ai_agents.published_version_id → a nova
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { publishRagBotVersion, RAG_BOT_PUBLISH_ERROR_CODES } from "@/lib/ai/agents/publish-rag-bot";

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) {
    return fail("invalid_request", "id inválido.", 400, { requestId });
  }

  const authz = await requireRole("admin", { requestId, resource: "ai_agents" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org: activeOrg } = authz;

  const admin = createAdminClient();

  const result = await publishRagBotVersion(admin, {
    orgId: activeOrg.orgId,
    agentId: id,
    createdBy: authUser.id,
  });

  if (!result.ok) {
    if (RAG_BOT_PUBLISH_ERROR_CODES.has(result.code)) {
      const status =
        result.code === "agent_not_found" || result.code === "version_not_found"
          ? 404
          : 422;
      return fail(result.code, "Validação de publish falhou.", status, { requestId });
    }
    return fail("internal_error", "Erro ao publicar.", 500, { requestId });
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
      if (error) console.error("[ai_agents/publish-rag-bot] event_log error", error.message);
    });

  void audit({
    action: "ai_agent.published",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "ai_agent",
    resourceId: id,
    requestId,
    metadata: {
      version_id: result.version_id,
      previous_version_id: result.previous_version_id,
    },
  });

  return ok(
    {
      agent_id: result.agent_id,
      version_id: result.version_id,
      previous_version_id: result.previous_version_id,
      published_at: result.published_at,
    },
    { requestId },
  );
}
