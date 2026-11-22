// app/api/v1/proposals/[id]/modelo/route.ts
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { traduzir } from "@/lib/i18n/dicionario";
import { resolverModelo } from "@/lib/propostas/modelos/resolver";
import { lerSecoesEditadas } from "@/lib/propostas/documento/documento-da-proposta";
import { sePropostasDesligadas } from "@/lib/propostas/porta";
import { resolverAvisoDeRevisaoSeProntaOuEncerrada } from "@/lib/propostas/aviso-de-revisao";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  template_slug: z.string().min(1).max(100).nullable(),
  descartar_reescritas: z.boolean().optional(),
});

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await resolveAuthDual(req, { requestId, resource: "crm_proposals", role: "manager", scope: "mcp:write" });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "proposals_modelo", requestId);
  if (teto) return teto;
  const desligada = await sePropostasDesligadas(authz.organizationId, requestId);
  if (desligada) return desligada;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);
  const { id } = await ctx.params;

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", t("Campos inválidos."), 422, { requestId });

  const admin = createAdminClient();
  const { data: proposta } = await admin
    .from("crm_proposals")
    .select("id, status, template_slug, secoes_editadas")
    .eq("organization_id", authz.organizationId)
    .eq("id", id)
    .maybeSingle();
  if (!proposta) return fail("not_found", t("Proposta não encontrada."), 404, { requestId });
  if ((proposta as { status: string }).status !== "rascunho") {
    return fail("proposal_context_stale", t("Só é possível trocar o modelo de uma proposta em rascunho."), 409, { requestId });
  }

  if (parsed.data.template_slug === null) {
    const { error } = await admin
      .from("crm_proposals")
      .update({ template_slug: null, template_version: null })
      .eq("organization_id", authz.organizationId)
      .eq("id", id);
    if (error) return fail("internal_error", t("Falha ao remover o modelo."), 500, { requestId });
    return ok({ template_slug: null }, { requestId });
  }

  const modelo = await resolverModelo(admin, authz.organizationId, parsed.data.template_slug);
  if (!modelo) return fail("validation_failed", t("Modelo não encontrado."), 422, { requestId });

  // §6.1 da spec de 21/09: trocar o modelo com rascunho em andamento perde o
  // texto ajustado à mão — por isso exige confirmação explícita.
  const atual = proposta as { template_slug: string | null; secoes_editadas: unknown };
  const trocaDeModelo = atual.template_slug !== null && atual.template_slug !== modelo.slug;
  const temReescrita = Object.keys(lerSecoesEditadas(atual.secoes_editadas)).length > 0;
  if (trocaDeModelo && temReescrita && parsed.data.descartar_reescritas !== true) {
    return fail(
      "proposal_context_stale",
      t("Esta proposta tem seções reescritas à mão. Confirme o descarte para trocar o modelo."),
      409,
      { requestId },
    );
  }

  const { error } = await admin
    .from("crm_proposals")
    .update({
      template_slug: modelo.slug,
      template_version: modelo.version,
      template_slug_sugerido: null,
      ...(trocaDeModelo ? { secoes_editadas: null } : {}),
    })
    .eq("organization_id", authz.organizationId)
    .eq("id", id);
  if (error) return fail("internal_error", t("Falha ao confirmar o modelo."), 500, { requestId });

  void resolverAvisoDeRevisaoSeProntaOuEncerrada(admin, authz.organizationId, id);

  void audit({
    action: "proposal.modelo_confirmado",
    actorUserId: authz.actor.type === "user" ? authz.actor.id : null,
    actorApiTokenId: authz.apiTokenId ?? null,
    organizationId: authz.organizationId,
    resourceType: "crm_proposals",
    resourceId: id,
    requestId,
    metadata: { template_slug: modelo.slug, template_version: modelo.version, descartou_reescritas: trocaDeModelo && temReescrita },
  });

  return ok({ template_slug: modelo.slug, template_version: modelo.version }, { requestId });
}
