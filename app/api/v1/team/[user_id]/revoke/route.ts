import { requireSupportWrite } from "@/lib/impersonate/support";
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
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { registrarTrocaDeComando } from "@/lib/inbox/atividade-de-comando";

export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ user_id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { user_id: targetUserId } = await ctx.params;

  const authz = await requireRole("admin", { requestId, resource: "team" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user: authUser, org: activeOrg } = authz;
  if (targetUserId === authUser.id) {
    return fail("state_conflict", t("Não é possível revogar o próprio acesso."), 409, { requestId });
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
        t("Não é possível revogar o último admin do tenant."),
        409,
        { requestId },
      );
    }
  }

  // Conversas abertas atribuídas a quem está saindo — o trigger do banco desatribui
  // para a fila e a rota grava a linha do tempo e o audit de liberação de cada uma (#1562).
  const { data: openConvs } = await supabase
    .from("conversations")
    .select("id, contact_id")
    .eq("organization_id", activeOrg.orgId)
    .eq("assigned_to_user_id", targetUserId)
    .in("status", ["open", "pending", "claimed", "ai_handling"]);

  const nowIso = new Date().toISOString();
  const { error: updErr } = await supabase
    .from("user_organizations")
    .update({ revoked_at: nowIso, updated_at: nowIso })
    .eq("id", target.id);
  if (updErr) return fail("internal_error", updErr.message, 500, { requestId });

  if (openConvs && openConvs.length > 0) {
    for (const conv of openConvs) {
      await audit({
        action: "conversation.released",
        actorUserId: authUser.id,
        organizationId: activeOrg.orgId,
        resourceType: "conversation",
        resourceId: conv.id,
        requestId,
        metadata: { reason: "member_revoked", target_user_id: targetUserId },
      });

      await registrarTrocaDeComando({
        supabase,
        organizationId: activeOrg.orgId,
        conversationId: conv.id,
        contactId: conv.contact_id,
        tipo: "conversation_released",
        actor: { type: "user", id: authUser.id, role: authz.org.role },
        motivo: "Atendente revogado da organização",
      });
    }
  }

  await audit({
    action: "member.revoked",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "membership",
    resourceId: target.id,
    requestId,
    metadata: {
      target_user_id: targetUserId,
      revoked_role: target.role,
      released_conversations_count: openConvs?.length ?? 0,
    },
  });

  return ok({ user_id: targetUserId, revoked_at: nowIso }, { requestId });
}
