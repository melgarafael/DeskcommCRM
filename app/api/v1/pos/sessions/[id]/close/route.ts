import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/* POST /api/v1/pos/sessions/:id/close — close session via RPC */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "pos" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;
  const { id } = await params;

  const body = await req.json().catch(() => null);
  if (body?.closing_balance == null) {
    return fail("validation", "closing_balance is required", 422, { requestId });
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema("finance").rpc("close_session_full", {
    p_session_id: id,
    p_closing_balance: body.closing_balance,
    p_organization_id: activeOrg.orgId,
  });

  if (error) return fail("rpc_error", error.message, 500, { requestId });
  return ok(data, { requestId });
}
