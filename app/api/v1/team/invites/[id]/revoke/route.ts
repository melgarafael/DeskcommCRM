/**
 * POST /api/v1/team/invites/[id]/revoke — cancela um convite pendente.
 *
 * admin-only. O token continua com assinatura e validade boas, mas o aceite
 * (`app/actions/team/acceptInvite.ts`) checa esta linha e recusa. É o único
 * jeito de cancelar um convite stateless.
 *
 * Idempotente: revogar de novo devolve 200 com `already_revoked: true`.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { NextRequest } from "next/server";

import { requireSupportWrite } from "@/lib/impersonate/support";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("admin", { requestId, resource: "team" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user: authUser, org: activeOrg } = authz;

  if (!z.string().uuid().safeParse(id).success) {
    return fail("invalid_request", t("Convite inválido."), 400, { requestId });
  }

  const supabase = await createClient();
  const { data: row, error: readErr } = await supabase
    .from("team_invites")
    .select("id, email, role, accepted_at, revoked_at")
    .eq("organization_id", activeOrg.orgId)
    .eq("id", id)
    .maybeSingle();
  if (readErr) return fail("internal_error", readErr.message, 500, { requestId });
  if (!row) return fail("not_found", t("Convite não encontrado."), 404, { requestId });
  if (row.accepted_at) {
    return fail("state_conflict", t("Este convite já foi aceito."), 409, { requestId });
  }
  if (row.revoked_at) {
    return ok({ id, already_revoked: true }, { requestId });
  }

  const nowIso = new Date().toISOString();
  const { error: updErr } = await supabase
    .from("team_invites")
    .update({ revoked_at: nowIso, revoked_by: authUser.id })
    .eq("id", id)
    .is("accepted_at", null)
    .is("revoked_at", null);
  if (updErr) return fail("internal_error", updErr.message, 500, { requestId });

  await audit({
    action: "member.invite_revoked",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "membership",
    resourceId: id,
    requestId,
    metadata: { email: row.email as string, role: row.role as string },
  });

  return ok({ id, revoked_at: nowIso }, { requestId });
}
