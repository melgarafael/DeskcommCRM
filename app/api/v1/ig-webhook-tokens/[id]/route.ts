/**
 * DELETE /api/v1/ig-webhook-tokens/[id]
 *
 * Revogação de token de webhook Instagram (soft-delete: ativo = false).
 *
 * Segurança: organization_id do cookie/JWT, nunca do body.
 */

import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireSupportWrite } from "@/lib/impersonate/support";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function DELETE(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("manager", { requestId, resource: "ig_webhook_tokens" });
  if (!authz.ok) return authz.response;

  const { organizationId, userId } = authz;

  const guarda = await requireSupportWrite({ requestId, resource: "ig_webhook_tokens.delete" });
  if (!guarda.ok) return guarda.response;

  const db = createAdminClient();

  const { data: existente, error: errBusca } = await db
    .from("ig_webhook_tokens")
    .select("id, descricao")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .single();

  if (errBusca || !existente) {
    return fail("not_found", "Token não encontrado", 404, { requestId });
  }

  // Soft-delete: desativa em vez de remover
  const { error } = await db
    .from("ig_webhook_tokens")
    .update({ ativo: false })
    .eq("id", id)
    .eq("organization_id", organizationId);

  if (error) {
    return fail("internal_error", "Erro ao revogar token", 500, { requestId });
  }

  await db.from("api_audit_log").insert({
    organization_id: organizationId,
    user_id: userId,
    action: "ig_webhook_tokens.delete",
    resource_id: id,
    metadata: { descricao: existente.descricao },
  });

  return ok({ revogado: true }, { headers: { "x-request-id": requestId } });
}
