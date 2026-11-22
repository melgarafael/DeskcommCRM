/**
 * DELETE /api/v1/vendas/[id] — apaga uma venda registrada.
 *
 * Quem pode: quem a registrou, ou gestor (`manager`+). A venda é procurada
 * pelo id E pela organização do cookie (admin client, filtro à mão): venda de
 * outra organização responde 404, igual a venda inexistente — sem confirmar
 * que o id existe em outro lugar. Audita `venda.apagada` com o que saiu.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { roleAtLeast } from "@/lib/auth/types";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { podeApagarVenda } from "@/lib/vendas/registradas";

export const dynamic = "force-dynamic";

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "vendas" });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return fail("not_found", "Venda não encontrada.", 404, { requestId });

  const admin = createAdminClient();
  const { data: venda, error } = await admin
    .from("vendas_registradas")
    .select("id, lead_id, contact_id, valor_cents, data, tags, created_by")
    .eq("organization_id", orgId)
    .eq("id", id)
    .maybeSingle();
  if (error) return fail("internal_error", "Não foi possível carregar a venda.", 500, { requestId });
  if (!venda) return fail("not_found", "Venda não encontrada.", 404, { requestId });

  const ehGestor = roleAtLeast(authz.org.role, "manager");
  if (!podeApagarVenda(venda as { created_by: string | null }, authz.user.id, ehGestor)) {
    return fail("forbidden", "Só quem registrou a venda ou um gestor pode apagá-la.", 403, { requestId });
  }

  const { error: erroAoApagar } = await admin
    .from("vendas_registradas")
    .delete()
    .eq("organization_id", orgId)
    .eq("id", id);
  if (erroAoApagar) return fail("internal_error", "Não foi possível apagar a venda.", 500, { requestId });

  void audit({
    action: "venda.apagada",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "venda_registrada",
    resourceId: id,
    requestId,
    metadata: venda as Record<string, unknown>,
  });
  return ok({ id }, { requestId });
}
