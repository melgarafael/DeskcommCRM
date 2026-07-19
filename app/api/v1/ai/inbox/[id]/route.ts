/**
 * PATCH /api/v1/ai/inbox/[id] — marca um aviso do runtime como resolvido (ou o
 * reabre). Operação de time (agent+), auditada. Operação Visível F1.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const patchSchema = z.object({
  status: z.enum(["open", "ack", "resolved"]),
});

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) return fail("invalid_request", "id inválido.", 400, { requestId });

  const authz = await requireRole("agent", { requestId, resource: "agent_inbox_items" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("invalid_request", "status deve ser open, ack ou resolved.", 400, { requestId });
  }

  const supabase = await createClient();
  const { data: updated, error } = await supabase
    .from("agent_inbox_items")
    .update({ status: parsed.data.status })
    .eq("organization_id", org.orgId)
    .eq("id", id)
    .select("id, status")
    .maybeSingle();
  if (error) return fail("internal_error", "Erro ao atualizar aviso.", 500, { requestId });
  if (!updated) return fail("not_found", "Aviso não encontrado.", 404, { requestId });

  void audit({
    action: "ai.inbox_item_updated",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "agent_inbox_item",
    resourceId: id,
    requestId,
    metadata: { status: parsed.data.status },
  });

  return ok(updated, { requestId });
}
