/**
 * DELETE /api/v1/campaign-suppressions/:id — tira o número da lista de exclusão.
 *
 * Tirar daqui NÃO desfaz opt-out: se a pessoa pediu para parar, `is_blocked`
 * continua valendo e nenhuma campanha a alcança. São duas listas, e esta é só a
 * da operação.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const negado = await requireSupportWrite();
  if (negado) return negado;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "campaign_suppressions" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await ctx.params;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("campaign_suppressions")
    .delete()
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .select("id, address_tail")
    .maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!data) return fail("campanha_nao_encontrada", t("Exclusão não encontrada."), 404, { requestId });

  void audit({
    action: "campaign.suppression_removed",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "campaign_suppression",
    resourceId: id,
    requestId,
    metadata: { final: (data as unknown as { address_tail: string | null }).address_tail },
  });

  return ok({ id }, { requestId });
}
