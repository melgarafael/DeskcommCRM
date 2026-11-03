import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PATCH  /api/v1/attendants/sectors/[id] — renomeia / redescreve (manager+).
 * DELETE /api/v1/attendants/sectors/[id] — apaga o setor (manager+).
 *
 * Apagar o setor solta os atendentes dele (FK `on delete cascade` no VÍNCULO,
 * migration 0801): eles ficam "sem setor", com jornada, carga e conversas
 * intactas. O audit guarda quantos estavam no setor, porque a linha do vínculo
 * deixa de existir e a trilha é o único lugar onde a resposta "quem estava lá"
 * sobrevive.
 *
 * Admin client com org filtrada à mão (activeOrg do cookie): a tabela não
 * concede escrita a `authenticated`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { ApiError } from "@/lib/api/types";
import { audit } from "@/lib/audit";
import { seSetoresDesligado } from "@/lib/atendimento/setores-modulo";
import { requireRole } from "@/lib/auth/require-role";
import { sectorPatchSchema, validateRequest } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const SELECT_COLS = "id, name, description, created_at, updated_at";
const idSchema = z.string().uuid();

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const desligado = await seSetoresDesligado(requestId);
  if (desligado) return desligado;
  const authz = await requireRole("manager", { requestId, resource: "attendant_sectors" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const { id } = await ctx.params;
  if (!idSchema.safeParse(id).success) {
    return fail("not_found", t("Setor não encontrado."), 404, { requestId });
  }

  let input;
  try {
    input = await validateRequest(sectorPatchSchema, req);
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
  const { data: row, error } = await admin
    .from("attendant_sectors")
    .update({ ...input, updated_at: new Date().toISOString() })
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .select(SELECT_COLS)
    .maybeSingle();

  if (error) {
    if (error.code === "23505") {
      return fail("sector_name_taken", t("Já existe um setor com este nome."), 409, { requestId });
    }
    return fail("internal_error", error.message, 500, { requestId });
  }
  if (!row) return fail("not_found", t("Setor não encontrado."), 404, { requestId });

  void audit({
    action: "attendant.sector_updated",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "attendant_sectors",
    resourceId: id,
    requestId,
    bypassedRls: true,
    metadata: { fields_changed: Object.keys(input), name: row.name },
  });

  return ok(row, { requestId });
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const desligado = await seSetoresDesligado(requestId);
  if (desligado) return desligado;
  const authz = await requireRole("manager", { requestId, resource: "attendant_sectors" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const { id } = await ctx.params;
  if (!idSchema.safeParse(id).success) {
    return fail("not_found", t("Setor não encontrado."), 404, { requestId });
  }

  const admin = createAdminClient();
  const { data: members, error: membersError } = await admin
    .from("attendant_sector_members")
    .select("user_id")
    .eq("organization_id", authz.org.orgId)
    .eq("sector_id", id);
  if (membersError) return fail("internal_error", membersError.message, 500, { requestId });

  const { data: row, error } = await admin
    .from("attendant_sectors")
    .delete()
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .select("id, name")
    .maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!row) return fail("not_found", t("Setor não encontrado."), 404, { requestId });

  void audit({
    action: "attendant.sector_deleted",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "attendant_sectors",
    resourceId: id,
    requestId,
    bypassedRls: true,
    metadata: {
      name: row.name,
      released_user_ids: (members ?? []).map((m) => m.user_id),
    },
  });

  return ok({ id: row.id, deleted: true }, { requestId });
}
