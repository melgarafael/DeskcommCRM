import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/* GET /api/v1/pos/sessions — list sessions, filter by state/user_id */
export async function GET(req: Request): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "pos" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const url = new URL(req.url);
  const state = url.searchParams.get("state");
  const userId = url.searchParams.get("user_id");

  const supabase = await createClient();
  let query = supabase
    .from("finance_pos_sessions")
    .select("*")
    .eq("organization_id", activeOrg.orgId)
    .order("opened_at", { ascending: false });

  if (state) query = query.eq("state", state);
  if (userId) query = query.eq("user_id", userId);

  const { data, error } = await query;
  if (error) return fail("db_error", error.message, 500, { requestId });
  return ok(data, { requestId });
}

/* POST /api/v1/pos/sessions — open a new session via RPC */
export async function POST(req: Request): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "pos" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg, user } = authz;

  const body = await req.json().catch(() => null);
  if (!body?.config_id || body.opening_balance == null) {
    return fail("validation", "config_id and opening_balance are required", 422, { requestId });
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema("finance").rpc("open_session", {
    p_config_id: body.config_id,
    p_user_id: user.id,
    p_opening_balance: body.opening_balance,
    p_organization_id: activeOrg.orgId,
  });

  if (error) return fail("rpc_error", error.message, 500, { requestId });
  return ok(data, { status: 201, requestId });
}
