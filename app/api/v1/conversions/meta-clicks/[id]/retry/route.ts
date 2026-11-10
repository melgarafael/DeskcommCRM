import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

/** Reprocessa uma oportunidade CTWA sem exigir ou fabricar card CRM. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const requestId = randomUUID();
  const parsed = z.object({ id: z.uuid() }).safeParse(await ctx.params);
  if (!parsed.success) return fail("validation_failed", "Clique inválido.", 400, { requestId });
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const authz = await requireRole("admin", { requestId, resource: "meta_ctwa_click_dispatches" });
  if (!authz.ok) return authz.response;
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("fn_solicitar_reenvio_meta_ctwa_click", {
    p_org: authz.org.orgId,
    p_click: parsed.data.id,
  });
  if (error)
    return fail("internal_error", "Não foi possível agendar o reprocessamento.", 500, {
      requestId,
    });
  if (data)
    await audit({
      action: "ad_conversion.retry_requested",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "meta_ctwa_click_dispatches",
      resourceId: parsed.data.id,
      requestId,
      metadata: { event_name: "LeadSubmitted", click_id: parsed.data.id },
    });
  return ok({ queued: Boolean(data) }, { requestId });
}
