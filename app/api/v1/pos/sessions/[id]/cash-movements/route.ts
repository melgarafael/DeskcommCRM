import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/* GET /api/v1/pos/sessions/:id/cash-movements — list movements for a session */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "pos" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;
  const { id } = await params;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("finance_cash_movements")
    .select("*")
    .eq("session_id", id)
    .eq("organization_id", activeOrg.orgId)
    .order("created_at", { ascending: false });

  if (error) return fail("db_error", error.message, 500, { requestId });
  return ok(data, { requestId });
}
