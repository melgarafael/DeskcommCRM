import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * Épico Operação Visível (F3) — POST: aplica uma proposta do flywheel como
 * versão NOVA do agente via publish-por-ponteiro (o clique É o gate humano).
 * Idempotência: proposta já aplicada → 409 (applied_at, migration 0053).
 *
 * Sessão OU token de integração (Spec 33, R1): o token precisa de `config:write`
 * e de papel admin (`tokenRole`) — aplicar publica versão nova do agente, o
 * mesmo poder da rota `publish`. A organização sai de `authz.organizationId`
 * (linha do token, nunca do path), e no ramo do token o cliente é a service
 * role: o filtro de `organization_id` de `applyProposal` é a única barreira.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
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

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id, pid } = await ctx.params;
  if (!UUID_RX.test(id) || !UUID_RX.test(pid)) {
    return fail("invalid_request", "id inválido.", 400, { requestId });
  }

  // Publicar versão é ato de admin — mesmo rank da rota de publish existente.
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "flywheel_proposals",
    role: "admin",
    scope: "config:write",
    tokenRole: "admin",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "flywheel_proposals", requestId);
  if (teto) return teto;
  const { organizationId } = authz;
  // Token de integração não é pessoa: `created_by`/`applied_by` recebem null,
  // nunca o id do token.
  const actorUserId = authz.actor.type === "user" ? authz.actor.id : null;
  const actorApiTokenId = authz.apiTokenId ?? null;

  const admin = createAdminClient();
  const result = await applyProposal(admin, {
    orgId: organizationId,
    agentId: id,
    proposalId: pid,
    userId: actorUserId,
  });

  if (!result.ok) {
    return fail(result.code, result.message, HTTP_BY_CODE[result.code], { requestId });
  }

  if ("entryId" in result) {
    await audit({
      action: "ai.flywheel_proposal_applied",
      actorUserId,
      actorApiTokenId,
      organizationId,
      resourceType: "flywheel_distiller_proposals",
      resourceId: pid,
      metadata: { agent_id: id, entry_id: result.entryId },
    });
    return ok({ entry_id: result.entryId }, { requestId });
  }

  await audit({
    action: "ai.flywheel_proposal_applied",
    actorUserId,
    actorApiTokenId,
    organizationId,
    resourceType: "flywheel_distiller_proposals",
    resourceId: pid,
    metadata: { agent_id: id, version_id: result.versionId, version_number: result.versionNumber },
  });

  return ok(
    { version_id: result.versionId, version_number: result.versionNumber },
    { requestId },
  );
}
