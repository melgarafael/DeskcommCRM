/**
 * PATCH  /api/v1/prospecting/prospects/[id] — status, não-contatar, bloquear.
 * DELETE /api/v1/prospecting/prospects/[id] — excluir (LGPD §26).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { COLUNAS_DO_PROSPECT, prospectPatchSchema } from "@/lib/schemas/prospeccao";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, { params }: Params): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "business_prospects" });
  if (!authz.ok) return authz.response;

  const parsed = prospectPatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success || Object.keys(parsed.data).length === 0) {
    return fail("validation_failed", "Dados inválidos.", 422, { requestId });
  }

  const { id } = await params;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("business_prospects")
    .update(parsed.data)
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .select(COLUNAS_DO_PROSPECT)
    .single();

  if (error || !data) return fail("not_found", "Prospect não encontrado.", 404, { requestId });

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "prospect.updated",
    resourceType: "business_prospects",
    resourceId: id,
    requestId,
  });

  return ok(data, { requestId });
}

export async function DELETE(_req: NextRequest, { params }: Params): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "business_prospects" });
  if (!authz.ok) return authz.response;

  const { id } = await params;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("business_prospects")
    .delete()
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .select("id")
    .maybeSingle();

  if (error || !data) return fail("not_found", "Prospect não encontrado.", 404, { requestId });

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "prospect.deleted",
    resourceType: "business_prospects",
    resourceId: id,
    requestId,
  });

  return ok({ id }, { requestId });
}
