/** DELETE /api/v1/contacts/[id]/advomax-link/processo-links/[processoCodigo]. */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { processoCodigoSchema } from "@/lib/advomax/processo-links";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
interface RouteCtx { params: Promise<{ id: string; processoCodigo: string }> }

export async function DELETE(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "advomax_process_link" });
  if (!authz.ok) return authz.response;
  const { id, processoCodigo } = await ctx.params;
  const parsed = processoCodigoSchema.safeParse(processoCodigo);
  if (!parsed.success) return fail("validation_failed", "Informe um código de processo válido.", 422, { requestId });
  const supabase = await createClient();
  const { data, error } = await supabase.from("advomax_contact_process_links" as never).delete()
    .eq("organization_id", authz.org.orgId).eq("contact_id", id).eq("processo_codigo", parsed.data)
    .select("id").maybeSingle();
  if (error) return fail("internal_error", "Não foi possível remover o vínculo de processo.", 500, { requestId });
  if (!data) return fail("not_found", "Vínculo de processo não encontrado.", 404, { requestId });
  await audit({ action: "contact.advomax_process_unlinked", actorUserId: authz.user.id, organizationId: authz.org.orgId,
    resourceType: "advomax_contact_process_link", resourceId: (data as { id: string }).id, requestId,
    metadata: { contact_id: id, processo_codigo: parsed.data } });
  return ok(null, { requestId });
}
