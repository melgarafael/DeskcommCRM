/**
 * PUT    /api/v1/fiscal-cfop-equivalentes/[id] — troca o destino (manager+).
 * DELETE /api/v1/fiscal-cfop-equivalentes/[id] — apaga a equivalência (manager+).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { cfopEquivalenteSchema } from "@/lib/schemas/fiscal";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "fiscal-cfop-equivalentes" });
  if (!authz.ok) return authz.response;

  const parsed = cfopEquivalenteSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "CFOP inválido (4 dígitos, origem ≠ destino).", 422, { requestId });
  }

  const { id } = await params;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("fiscal_cfop_equivalentes")
    .update({ cfop_origem: parsed.data.cfop_origem, cfop_destino: parsed.data.cfop_destino })
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .select("id, cfop_origem, cfop_destino, created_at")
    .maybeSingle();

  if (error) {
    if ((error as { code?: string }).code === "23505") {
      return fail("conflict", "Esta origem já tem outra equivalência.", 409, { requestId });
    }
    return fail("internal_error", "Erro ao atualizar a equivalência.", 500, { requestId });
  }
  if (!data) return fail("not_found", "Equivalência não encontrada.", 404, { requestId });

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "fiscal.cfop_equivalente",
    resourceType: "fiscal_cfop_equivalentes",
    resourceId: id,
    requestId,
  });

  return ok(data, { requestId });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "fiscal-cfop-equivalentes" });
  if (!authz.ok) return authz.response;

  const { id } = await params;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("fiscal_cfop_equivalentes")
    .delete()
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .select("id")
    .maybeSingle();

  if (error) return fail("internal_error", "Erro ao apagar a equivalência.", 500, { requestId });
  if (!data) return fail("not_found", "Equivalência não encontrada.", 404, { requestId });

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "fiscal.cfop_equivalente",
    resourceType: "fiscal_cfop_equivalentes",
    resourceId: id,
    requestId,
  });

  return ok({ id }, { requestId });
}
