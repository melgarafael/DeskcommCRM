/**
 * Épico Operação Visível (F3) — POST: aplica uma proposta do flywheel como
 * versão NOVA do agente via publish-por-ponteiro (o clique É o gate humano).
 * Idempotência: proposta já aplicada → 409 (applied_at, migration 0053).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { applyProposal, type ApplyProposalErrorCode } from "@/lib/ai/apply-proposal";

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const HTTP_BY_CODE: Record<ApplyProposalErrorCode, number> = {
  proposal_not_found: 404,
  proposal_already_applied: 409,
  proposal_type_unsupported: 422,
  agent_not_published: 422,
  publish_failed: 422,
  internal_error: 500,
};

type Ctx = { params: Promise<{ id: string; pid: string }> };

export async function POST(_req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const { id, pid } = await ctx.params;
  if (!UUID_RX.test(id) || !UUID_RX.test(pid)) {
    return fail("invalid_request", "id inválido.", 400, { requestId });
  }

  // Publicar versão é ato de admin — mesmo rank da rota de publish existente.
  const authz = await requireRole("admin", { requestId, resource: "flywheel_proposals" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org } = authz;

  const admin = createAdminClient();
  const result = await applyProposal(admin, {
    orgId: org.orgId,
    agentId: id,
    proposalId: pid,
    userId: authUser.id,
  });

  if (!result.ok) {
    return fail(result.code, result.message, HTTP_BY_CODE[result.code], { requestId });
  }

  await audit({
    action: "ai.flywheel_proposal_applied",
    actorUserId: authUser.id,
    organizationId: org.orgId,
    resourceType: "flywheel_distiller_proposals",
    resourceId: pid,
    metadata: { agent_id: id, version_id: result.versionId, version_number: result.versionNumber },
  });

  return ok(
    { version_id: result.versionId, version_number: result.versionNumber },
    { requestId },
  );
}
