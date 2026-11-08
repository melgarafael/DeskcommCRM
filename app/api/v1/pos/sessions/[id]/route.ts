import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/* GET /api/v1/pos/sessions/:id — single session with expected balance */
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

  const { data: session, error } = await supabase
    .from("finance_pos_sessions")
    .select("*")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .single();

  if (error || !session) return fail("not_found", "Session not found", 404, { requestId });

  const { data: expectedBalance } = await supabase
    .schema("finance")
    .rpc("compute_session_expected_balance", { p_session_id: id });

  return ok({ ...session, expected_balance: expectedBalance }, { requestId });
}
