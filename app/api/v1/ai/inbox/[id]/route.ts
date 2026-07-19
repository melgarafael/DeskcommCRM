/**
 * Épico Operação Visível (F1) — transição de status de um aviso do agente.
 * PATCH { status: 'ack' | 'resolved' | 'open' } — org-scoped, auditado.
 * Reabrir (→'open') é permitido: resolver por engano não pode esconder alerta.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bodySchema = z.object({ status: z.enum(["open", "ack", "resolved"]) }).strict();

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) {
    return fail("invalid_request", "id inválido.", 400, { requestId });
  }

  const authz = await requireRole("agent", { requestId, resource: "agent_inbox_items" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org } = authz;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400, { requestId });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", "Campos inválidos.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("agent_inbox_items")
    .update({ status: parsed.data.status })
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .select("id, kind, severity, title, body, ref_kind, ref_id, status, created_at")
    .maybeSingle();
  if (error) {
    return fail("internal_error", "Falha ao atualizar o aviso.", 500, { requestId });
  }
  if (!data) {
    return fail("not_found", "Aviso não encontrado nesta organização.", 404, { requestId });
  }

  await audit({
    action: "ai.inbox_item_status_changed",
    actorUserId: authUser.id,
    organizationId: org.orgId,
    resourceType: "agent_inbox_items",
    resourceId: id,
    metadata: { status: parsed.data.status },
  });

  return ok({ item: data }, { requestId });
}
