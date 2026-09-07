import { requireSupportWrite } from "@/lib/impersonate/support";
import { randomUUID } from "node:crypto";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { agendaSettingsSchema, agendaSettingsWriteSchema } from "@/lib/schemas/settings";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";

export async function GET() {
  const requestId = randomUUID();
  const auth = await requireRole("viewer", { requestId, resource: "agenda" });
  if (!auth.ok) return auth.response;
  const { data, error } = await (
    await createClient()
  )
    .from("organizations")
    .select("settings")
    .eq("id", auth.org.orgId)
    .single();
  if (error)
    return fail("internal_error", "Não foi possível carregar os prazos.", 500, { requestId });
  return ok(agendaSettingsSchema.parse(data.settings?.agenda), { requestId });
}
export async function PATCH(req: Request) {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const auth = await requireRole("manager", { requestId, resource: "agenda" });
  if (!auth.ok) return auth.response;
  const parsed = agendaSettingsWriteSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return fail("validation_failed", "Confira os prazos de confirmação e proteção.", 422, {
      requestId,
    });
  const { data, error } = await (
    await createClient()
  ).rpc("fn_agenda_settings", { p_org: auth.org.orgId, p_config: parsed.data });
  if (error)
    return fail(
      error.code === "42501" ? "forbidden" : "internal_error",
      "Não foi possível alterar os prazos desta organização.",
      error.code === "42501" ? 403 : 500,
      { requestId },
    );
  void audit({
    action: "agenda.settings_updated",
    organizationId: auth.org.orgId,
    actorUserId: auth.user.id,
    requestId,
    resourceType: "organization",
    resourceId: auth.org.orgId,
    metadata: parsed.data,
  });
  return ok(data, { requestId });
}
