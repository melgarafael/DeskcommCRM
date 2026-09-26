import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const requestId = randomUUID();
  const parsed = z.object({ id: z.uuid() }).safeParse(await ctx.params);
  if (!parsed.success) return fail("validation_failed", "Negócio inválido.", 400, { requestId });
  const evento = z
    .enum(["Purchase", "QualifiedLead"])
    .safeParse(new URL(req.url).searchParams.get("event_name") ?? "Purchase");
  if (!evento.success) return fail("validation_failed", "Evento inválido.", 400, { requestId });
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const authz = await requireRole("admin", { requestId, resource: "ad_conversion_dispatches" });
  if (!authz.ok) return authz.response;
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("fn_solicitar_reenvio_conversao", {
    p_org: authz.org.orgId,
    p_lead: parsed.data.id,
    ...(evento.data === "QualifiedLead" ? { p_event: evento.data } : {}),
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
      resourceType: "crm_leads",
      resourceId: parsed.data.id,
      requestId,
      metadata: { event_name: evento.data },
    });
  return ok({ queued: Boolean(data) }, { requestId });
}
