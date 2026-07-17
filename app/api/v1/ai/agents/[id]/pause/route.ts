/**
 * POST /api/v1/ai/agents/:id/pause (admin)
 *
 * Spec 10 §4.3. Limpa published_version_id (agente não responde gatilhos),
 * mas mantém archived_at=null. Versão antes-published vira 'superseded' pra
 * preservar continuidade do versionamento.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) return fail("invalid_request", "id inválido.", 400, { requestId });

  const authz = await requireRole("admin", { requestId, resource: "ai_agents" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org: activeOrg } = authz;

  const admin = createAdminClient();
  const { data: existing } = await admin
    .from("ai_agents")
    .select("id, published_version_id, archived_at")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();

  if (!existing) return fail("not_found", "Agent não encontrado.", 404, { requestId });
  if (existing.archived_at) {
    return fail("state_conflict", "Agent arquivado.", 409, { requestId });
  }

  const previousVersionId = existing.published_version_id as string | null;

  if (previousVersionId) {
    await admin
      .from("ai_agent_versions")
      .update({ status: "superseded", superseded_at: new Date().toISOString() })
      .eq("id", previousVersionId)
      .eq("organization_id", activeOrg.orgId)
      .eq("status", "published");
  }

  const { error } = await admin
    .from("ai_agents")
    .update({ published_version_id: null, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId);

  if (error) return fail("internal_error", "Erro ao pausar agent.", 500, { requestId });

  void audit({
    action: "ai_agent.paused",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "ai_agent",
    resourceId: id,
    requestId,
    metadata: { previous_version_id: previousVersionId },
  });

  return ok({ id, published_version_id: null }, { requestId });
}
