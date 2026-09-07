import { requireSupportWrite } from "@/lib/impersonate/support";
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
import { duplicateAgentWithVersion } from "@/lib/ai/agents/duplicate";

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) return fail("invalid_request", "id inválido.", 400, { requestId });

  const authz = await requireRole("admin", { requestId, resource: "ai_agents" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org: activeOrg } = authz;

  const admin = createAdminClient();

  // Implementação compartilhada com o botão "Duplicar" da lista
  // (`duplicateAgentAction`), que fazia cópia rasa e devolvia agente em branco.
  const result = await duplicateAgentWithVersion(admin, {
    orgId: activeOrg.orgId,
    agentId: id,
    actorUserId: authUser.id,
    requireVersion: true,
  });

  if (!result.ok) {
    if (result.error === "not_found") {
      return fail("not_found", "Agent não encontrado.", 404, { requestId });
    }
    if (result.error === "no_version_to_duplicate") {
      return fail("state_conflict", "Agent não tem versão para duplicar.", 409, { requestId });
    }
    return fail(
      "internal_error",
      result.error === "version_insert_failed" ? "Erro ao duplicar versão." : "Erro ao duplicar agent.",
      500,
      { requestId },
    );
  }

  void audit({
    action: "ai_agent.duplicated",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "ai_agent",
    resourceId: (result.agent as { id: string }).id,
    requestId,
    // `source_version_id` responde "cópia de QUAL versão?" — a nova (`result.version`)
    // não responde isso. Foi perdido na reescrita que extraiu o helper e voltou aqui
    // porque o audit é append-only: linha emitida pobre não se enriquece depois.
    metadata: {
      source_agent_id: id,
      source_version_id: result.sourceVersionId,
      source_version_copied: result.version !== null,
    },
  });

  return ok({ agent: result.agent, version: result.version }, { status: 201, requestId });
}
