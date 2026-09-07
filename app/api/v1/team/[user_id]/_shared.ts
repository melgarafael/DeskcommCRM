/**
 * Shared handler: change a member's role (G2-02).
 *
 * Canonical route: PATCH /api/v1/team/[user_id]
 * Alias (EPIC-09, kept for existing callers): PATCH /api/v1/team/[user_id]/role
 *
 * Guardrails:
 *  - Caller must be admin of the active org (requireRole, spec 13 §4).
 *  - Cannot demote the last remaining admin (count check before write).
 *  - Cannot change role of a revoked member.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { ApiError } from "@/lib/api/types";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { changeRoleSchema, validateRequest } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";

export async function changeMemberRole(
  req: NextRequest,
  ctx: { params: Promise<{ user_id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { user_id: targetUserId } = await ctx.params;

  const authz = await requireRole("admin", { requestId, resource: "team" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org: activeOrg } = authz;
  const t = (texto: string) => traduzir(texto, authUser.idioma);

  let input;
  try {
    input = await validateRequest(changeRoleSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  const supabase = await createClient();

  const { data: target, error: fetchErr } = await supabase
    .from("user_organizations")
    .select("id, user_id, role, revoked_at")
    .eq("organization_id", activeOrg.orgId)
    .eq("user_id", targetUserId)
    .maybeSingle();
  if (fetchErr) return fail("internal_error", fetchErr.message, 500, { requestId });
  if (!target) return fail("not_found", t("Membro não encontrado."), 404, { requestId });
  if (target.revoked_at) {
    return fail("state_conflict", t("Membro está revogado."), 409, { requestId });
  }

  if (target.role === "admin" && input.role !== "admin") {
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
        t("Não é possível rebaixar o último admin do tenant."),
        409,
        { requestId },
      );
    }
  }

  const { error: updErr } = await supabase
    .from("user_organizations")
    .update({ role: input.role, updated_at: new Date().toISOString() })
    .eq("id", target.id);
  if (updErr) return fail("internal_error", updErr.message, 500, { requestId });

  await audit({
    action: "team.role_changed",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "membership",
    resourceId: target.id,
    requestId,
    metadata: {
      target_user_id: targetUserId,
      old_role: target.role,
      new_role: input.role,
    },
  });

  return ok({ user_id: targetUserId, role: input.role }, { requestId });
}
