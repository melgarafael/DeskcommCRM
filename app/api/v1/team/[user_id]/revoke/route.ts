/**
 * POST /api/v1/team/[user_id]/revoke — revoke a member.
 *
 * Guardrails:
 *  - Caller must be admin of the active org.
 *  - Cannot revoke self.
 *  - Cannot revoke the last admin.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ user_id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { user_id: targetUserId } = await ctx.params;

  const authUser = await loadAuthUser();
  if (!authUser) return fail("unauthenticated", "Auth required.", 401, { requestId });
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) return fail("forbidden_tenant", "Sem organização ativa.", 403, { requestId });
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    return fail("forbidden_role", "Apenas admins podem revogar membros.", 403, { requestId });
  }
  if (targetUserId === authUser.id) {
    return fail("state_conflict", "Não é possível revogar o próprio acesso.", 409, { requestId });
  }

  const supabase = await createClient();

  const { data: target, error: fetchErr } = await supabase
    .from("user_organizations")
    .select("id, user_id, role, revoked_at")
    .eq("organization_id", activeOrg.orgId)
    .eq("user_id", targetUserId)
    .maybeSingle();
  if (fetchErr) return fail("internal_error", fetchErr.message, 500, { requestId });
  if (!target) return fail("not_found", "Membro não encontrado.", 404, { requestId });
  if (target.revoked_at) {
    return ok({ user_id: targetUserId, already_revoked: true }, { requestId });
  }

  if (target.role === "admin") {
    const { count, error: countErr } = await supabase
      .from("user_organizations")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", activeOrg.orgId)
      .eq("role", "admin")
      .is("revoked_at", null);
    if (countErr) return fail("internal_error", countErr.message, 500, { requestId });
    if ((count ?? 0) <= 1) {
      return fail(
        "state_conflict",
        "Não é possível revogar o último admin do tenant.",
        409,
        { requestId },
      );
    }
  }

  const nowIso = new Date().toISOString();
  const { error: updErr } = await supabase
    .from("user_organizations")
    .update({ revoked_at: nowIso, updated_at: nowIso })
    .eq("id", target.id);
  if (updErr) return fail("internal_error", updErr.message, 500, { requestId });

  await audit({
    action: "member.revoked",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "membership",
    resourceId: target.id,
    requestId,
    metadata: { target_user_id: targetUserId, revoked_role: target.role },
  });

  return ok({ user_id: targetUserId, revoked_at: nowIso }, { requestId });
}
