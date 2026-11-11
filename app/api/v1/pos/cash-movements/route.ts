import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/* GET /api/v1/pos/cash-movements — list cash movements, optionally filtered by session_id */
export async function GET(req: Request): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "pos" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const url = new URL(req.url);
  const sessionId = url.searchParams.get("session_id");

  const supabase = await createClient();
  let query = supabase
    .from("finance_cash_movements")
    .select("*")
    .eq("organization_id", activeOrg.orgId)
    .order("created_at", { ascending: false });

  if (sessionId) {
    query = query.eq("session_id", sessionId);
  }

  const { data, error } = await query;
  if (error) return fail("db_error", error.message, 500, { requestId });
  return ok(data, { requestId });
}

/* POST /api/v1/pos/cash-movements — register a cash in/out movement */
export async function POST(req: Request): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "pos" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg, user } = authz;

  const body = await req.json().catch(() => null);
  if (!body?.session_id || body?.amount == null || !body?.reason) {
    return fail("validation", "session_id, amount and reason are required", 422, { requestId });
  }
  if (body.amount === 0) {
    return fail("validation", "amount cannot be zero", 422, { requestId });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("finance_cash_movements")
    .insert({
      session_id: body.session_id,
      amount: body.amount,
      reason: body.reason.trim(),
      user_id: user.id,
      organization_id: activeOrg.orgId,
    })
    .select()
    .single();

  if (error) return fail("db_error", error.message, 500, { requestId });
  return ok(data, { status: 201, requestId });
}
