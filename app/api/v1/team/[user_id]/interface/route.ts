import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { NextRequest } from "next/server";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { interfaceSettingsSchema, interfaceTemDestino } from "@/lib/navigation/interface";
import type { Role } from "@/lib/auth/types";
import { audit } from "@/lib/audit";
import { ok, fail } from "@/lib/api/wrappers";
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ user_id: string }> }) {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "team" });
  if (!authz.ok) return authz.response;
  const { user_id } = await ctx.params;
  const parsed = z
    .object({ interface_settings: interfaceSettingsSchema })
    .strict()
    .safeParse(await req.json().catch(() => null));
  if (!z.string().uuid().safeParse(user_id).success || !parsed.success)
    return fail("validation_error", "Confira a seleção de áreas.", 400, { requestId });
  const db = await createClient();
  const { data: member, error: readError } = await db
    .from("user_organizations")
    .select("role")
    .eq("organization_id", authz.org.orgId)
    .eq("user_id", user_id)
    .is("revoked_at", null)
    .not("accepted_at", "is", null)
    .maybeSingle();
  if (readError)
    return fail("internal_error", "Não foi possível ler o membro.", 500, { requestId });
  if (!member) return fail("not_found", "Membro ativo não encontrado.", 404, { requestId });
  if (!interfaceTemDestino(parsed.data.interface_settings, member.role as Role))
    return fail("validation_error", "Selecione ao menos uma área permitida ao papel.", 400, {
      requestId,
    });
  const { data, error } = await db
    .from("user_organizations")
    .update({ interface_settings: parsed.data.interface_settings })
    .eq("organization_id", authz.org.orgId)
    .eq("user_id", user_id)
    .eq("role", member.role)
    .is("revoked_at", null)
    .not("accepted_at", "is", null)
    .select("id, user_id, interface_settings")
    .maybeSingle();
  if (error)
    return fail("internal_error", "Não foi possível salvar a interface.", 500, { requestId });
  if (!data)
    return fail("conflict", "O vínculo mudou. Atualize e tente novamente.", 409, { requestId });
  void audit({
    action: "team.interface_changed",
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    resourceType: "membership",
    resourceId: data.id,
    requestId,
    metadata: { user_id, interface_settings: parsed.data.interface_settings },
  });
  return ok(data, { requestId });
}
