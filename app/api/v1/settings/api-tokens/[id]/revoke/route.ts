import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/settings/api-tokens/[id]/revoke — revoke an API token.
 * Idempotent: revoking an already-revoked token returns ok with already_revoked=true.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

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

  const authz = await requireRole("admin", { requestId, resource: "api_tokens" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user: authUser, org: activeOrg } = authz;

  const supabase = await createClient();
  const { data: token, error: fetchErr } = await supabase
    .from("api_tokens")
    .select("id, revoked_at")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (fetchErr) return fail("internal_error", fetchErr.message, 500, { requestId });
  if (!token) return fail("not_found", t("Token não encontrado."), 404, { requestId });
  if (token.revoked_at) {
    return ok({ id, already_revoked: true }, { requestId });
  }

  const nowIso = new Date().toISOString();
  const { error: updErr } = await supabase
    .from("api_tokens")
    .update({ revoked_at: nowIso, revoked_by: authUser.id, updated_at: nowIso })
    .eq("id", id);
  if (updErr) return fail("internal_error", updErr.message, 500, { requestId });

  await audit({
    action: "token.revoked",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "api_token",
    resourceId: id,
    requestId,
  });

  return ok({ id, revoked_at: nowIso }, { requestId });
}
