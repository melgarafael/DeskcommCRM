import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

type Ctx = { params: Promise<{ id: string; scheduledId: string }> };

export async function DELETE(_req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "scheduled_messages" });
  if (!authz.ok) return authz.response;
  const { id, scheduledId } = await ctx.params;
  if (
    !z.string().uuid().safeParse(id).success ||
    !z.string().uuid().safeParse(scheduledId).success
  ) {
    return fail("validation_error", "Agendamento inválido.", 422, { requestId });
  }
  const db = await createClient();
  const { data: conversa } = await db
    .from("conversations")
    .select("id")
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .maybeSingle();
  if (!conversa) return fail("not_found", "Conversa não encontrada.", 404, { requestId });

  const { data, error } = await createAdminClient()
    .from("scheduled_messages")
    .update({
      status: "cancelled",
      finished_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("organization_id", authz.org.orgId)
    .eq("conversation_id", id)
    .eq("id", scheduledId)
    .eq("status", "pending")
    .select("id, status")
    .maybeSingle();
  if (error) return fail("internal_error", "Não foi possível cancelar.", 500, { requestId });
  if (!data)
    return fail("already_terminal", "A mensagem já saiu, foi cancelada ou está em envio.", 409, {
      requestId,
    });
  void audit({
    action: "message.schedule_cancelled",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "scheduled_message",
    resourceId: scheduledId,
    requestId,
    metadata: { conversation_id: id },
  });
  return ok(data, { requestId });
}
