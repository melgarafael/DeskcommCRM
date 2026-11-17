/**
 * DELETE /api/v1/campaign-suppressions/:id — tira o número da lista de exclusão.
 *
 * Tirar daqui NÃO desfaz opt-out: se a pessoa pediu para parar, `is_blocked`
 * continua valendo e nenhuma campanha a alcança. São duas listas, e esta é só a
 * da operação.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const negado = await requireSupportWrite();
  if (negado) return negado;

  const requestId = randomUUID();
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "campaign_suppressions",
    role: "manager",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "campaign_suppressions_excluir", requestId);
  if (teto) return teto;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);
  const org = { orgId: authz.organizationId };
  const { id } = await ctx.params;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("campaign_suppressions")
    .delete()
    .eq("organization_id", org.orgId)
    .eq("id", id)
    .select("id, address_tail")
    .maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!data) return fail("campanha_nao_encontrada", t("Exclusão não encontrada."), 404, { requestId });

  void audit({
    action: "campaign.suppression_removed",
    actorUserId: authz.actor.type === "user" ? authz.actor.id : null,
    actorApiTokenId: authz.apiTokenId ?? null,
    organizationId: org.orgId,
    resourceType: "campaign_suppression",
    resourceId: id,
    requestId,
    metadata: { final: (data as unknown as { address_tail: string | null }).address_tail },
  });

  return ok({ id }, { requestId });
}
