/**
 * Épico Operação Visível (F1) — resolve em massa todos os avisos abertos da org.
 * POST sem body. Org-scoped, auditado (1 entrada, com a contagem).
 */
import { randomUUID } from "node:crypto";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function POST(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "agent_inbox_items" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org } = authz;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("agent_inbox_items")
    .update({ status: "resolved" })
    .eq("organization_id", org.orgId)
    .eq("status", "open")
    .select("id");
  if (error) {
    return fail("internal_error", "Falha ao resolver os avisos.", 500, { requestId });
  }

  const count = data?.length ?? 0;
  if (count > 0) {
    await audit({
      action: "ai.inbox_item_status_changed",
      actorUserId: authUser.id,
      organizationId: org.orgId,
      resourceType: "agent_inbox_items",
      resourceId: "bulk",
      metadata: { status: "resolved", bulk: true, count },
    });
  }

  return ok({ resolved_count: count }, { requestId });
}
