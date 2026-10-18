import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * DELETE /api/v1/scheduled-messages/[id] — cancela (status=cancelled) um pending.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, noContent } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function DELETE(_req: NextRequest, { params }: RouteParams): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "scheduled_messages" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;
  const { id } = await params;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("scheduled_messages")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();
  if (error) return fail("internal_error", "Erro ao cancelar agendamento.", 500, { requestId });
  if (!data) return fail("not_found", t("Agendamento não encontrado."), 404, { requestId });

  void audit({
    action: "scheduled_message.cancelled",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "scheduled_message",
    resourceId: data.id,
    requestId,
  });
  return noContent(requestId);
}
