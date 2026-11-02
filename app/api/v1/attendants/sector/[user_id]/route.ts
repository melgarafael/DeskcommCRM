import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PUT /api/v1/attendants/sector/[user_id] — põe o atendente num setor, troca
 * de setor ou tira do setor (`sector_id: null`). Manager+.
 *
 * Um setor por atendente: a chave do vínculo é `(organization_id, user_id)`
 * (migration 0801), então trocar é upsert da mesma linha. O PRÓPRIO atendente
 * não escolhe o setor — é decisão de quem gerencia a equipe, e por isso a
 * tabela não concede escrita a `authenticated`.
 *
 * O alvo tem de ser membro ATIVO da org e o setor tem de ser DESTA org: as FKs
 * compostas já recusariam o setor de outra org, mas a checagem aqui devolve
 * 404 com frase em vez de um 500 de constraint. Org de fonte confiável
 * (activeOrg do cookie), nunca do corpo.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { ApiError } from "@/lib/api/types";
import { audit } from "@/lib/audit";
import { seSetoresDesligado } from "@/lib/atendimento/setores-modulo";
import { requireRole } from "@/lib/auth/require-role";
import { sectorAssignmentSchema, validateRequest } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

export async function PUT(
  req: NextRequest,
  ctx: { params: Promise<{ user_id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const desligado = await seSetoresDesligado(requestId);
  if (desligado) return desligado;
  const authz = await requireRole("manager", { requestId, resource: "attendant_sector_members" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;
  const { user_id: targetUserId } = await ctx.params;

  let input;
  try {
    input = await validateRequest(sectorAssignmentSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  const admin = createAdminClient();

  const { data: member, error: memberErr } = await admin
    .from("user_organizations")
    .select("user_id")
    .eq("organization_id", orgId)
    .eq("user_id", targetUserId)
    .is("revoked_at", null)
    .maybeSingle();
  if (memberErr) return fail("internal_error", memberErr.message, 500, { requestId });
  if (!member) return fail("not_found", t("Atendente não encontrado na organização."), 404, { requestId });

  const { data: previous, error: previousErr } = await admin
    .from("attendant_sector_members")
    .select("sector_id")
    .eq("organization_id", orgId)
    .eq("user_id", targetUserId)
    .maybeSingle();
  if (previousErr) return fail("internal_error", previousErr.message, 500, { requestId });
  const previousSectorId = previous?.sector_id ?? null;

  if (input.sector_id === null) {
    const { error } = await admin
      .from("attendant_sector_members")
      .delete()
      .eq("organization_id", orgId)
      .eq("user_id", targetUserId);
    if (error) return fail("internal_error", error.message, 500, { requestId });
  } else {
    const { data: sector, error: sectorErr } = await admin
      .from("attendant_sectors")
      .select("id")
      .eq("organization_id", orgId)
      .eq("id", input.sector_id)
      .maybeSingle();
    if (sectorErr) return fail("internal_error", sectorErr.message, 500, { requestId });
    if (!sector) return fail("not_found", t("Setor não encontrado."), 404, { requestId });

    const { error } = await admin
      .from("attendant_sector_members")
      .upsert(
        {
          organization_id: orgId,
          user_id: targetUserId,
          sector_id: input.sector_id,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "organization_id,user_id" },
      );
    if (error) return fail("internal_error", error.message, 500, { requestId });
  }

  // Nada mudou (mesmo setor de antes): não é mutação, não audita.
  if (previousSectorId !== input.sector_id) {
    void audit({
      action: "attendant.sector_assigned",
      actorUserId: authz.user.id,
      organizationId: orgId,
      resourceType: "attendant_sector_members",
      resourceId: targetUserId,
      requestId,
      bypassedRls: true,
      metadata: {
        target_user_id: targetUserId,
        from_sector_id: previousSectorId,
        to_sector_id: input.sector_id,
      },
    });
  }

  return ok({ user_id: targetUserId, sector_id: input.sector_id }, { requestId });
}
