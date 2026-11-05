/**
 * DELETE /api/v1/mensagens-agendadas/[id] — cancela a série. O histórico de envios fica.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { audit } from "@/lib/audit";
import { ok, fail } from "@/lib/api/wrappers";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const requestId = randomUUID();
  const auth = await requireRole("agent", { requestId, resource: "mensagens_agendadas" });
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return fail("validation_failed", "id inválido.", 422, { requestId });

  const { data, error } = await createAdminClient()
    .from("mensagens_agendadas")
    .update({ status: "cancelada", claimed_until: null, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", auth.org.orgId)
    .eq("status", "agendada")
    .select("id");
  if (error) return fail("internal_error", "Não consegui cancelar o agendamento.", 500, { requestId });
  if (!data?.length) return fail("not_found", "Agendamento não encontrado ou já terminado.", 404, { requestId });

  void audit({
    action: "scheduled_message.cancelled",
    organizationId: auth.org.orgId,
    actorUserId: auth.user.id,
    resourceType: "mensagens_agendadas",
    resourceId: id,
    requestId,
  });
  return ok({ id, status: "cancelada" }, { requestId });
}
