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
import { desativarAtivacaoDoModulo } from "@/lib/extensions/desativar-do-token";
import { extensionFailure } from "@/lib/extensions/http";
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
    .select("id, revoked_at, extension_installation_id, module_slug")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (fetchErr) return fail("internal_error", fetchErr.message, 500, { requestId });
  if (!token) return fail("not_found", t("Token não encontrado."), 404, { requestId });
  if (token.revoked_at) {
    return ok({ id, already_revoked: true }, { requestId });
  }

  // Token de MÓDULO (spec 33, F2): revogá-lo é DESATIVAR a ativação do par nesta organização. O banco
  // revoga o token na mesma transação (`fn_extensions_configure`, desativar). Revogar só a linha deixaria
  // o módulo "ativado" sem token, e a próxima busca criaria outro: a tela mentiria.
  if (token.extension_installation_id) {
    if (authz.user.support) {
      return fail("forbidden", t("Saia do acompanhamento para desativar módulos."), 403, {
        requestId,
      });
    }
    let desativado: boolean;
    try {
      desativado = await desativarAtivacaoDoModulo(
        authz.user.id,
        activeOrg.orgId,
        token.extension_installation_id,
      );
    } catch (error) {
      return extensionFailure(error, authz.user.idioma);
    }
    if (desativado) {
      const { data: depois } = await supabase
        .from("api_tokens")
        .select("revoked_at")
        .eq("id", id)
        .eq("organization_id", activeOrg.orgId)
        .maybeSingle();
      if (depois?.revoked_at) {
        return ok(
          { id, revoked_at: depois.revoked_at, module_deactivated: true, module: token.module_slug },
          { requestId },
        );
      }
    }
    // Ativação já desligada (ou o banco não revogou): cai na revogação direta da linha, sem inventar.
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
