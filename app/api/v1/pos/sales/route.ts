import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/* GET /api/v1/pos/sales — list sales, filter by session_id, state, date range */
export async function GET(req: Request): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "pos" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const url = new URL(req.url);
  const sessionId = url.searchParams.get("session_id");
  const state = url.searchParams.get("state");
  const dateFrom = url.searchParams.get("date_from");
  const dateTo = url.searchParams.get("date_to");

  const supabase = await createClient();
  let query = supabase
    .from("finance_sales")
    .select("*")
    .eq("organization_id", activeOrg.orgId)
    .order("date", { ascending: false });

  if (sessionId) query = query.eq("session_id", sessionId);
  if (state) query = query.eq("state", state);
  if (dateFrom) query = query.gte("date", dateFrom);
  if (dateTo) query = query.lte("date", dateTo);

  const { data, error } = await query;
  if (error) return fail("db_error", error.message, 500, { requestId });
  return ok(data, { requestId });
}

/* POST /api/v1/pos/sales — create sale via RPC (atomic) */
export async function POST(req: Request): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "pos" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const body = await req.json().catch(() => null);
  if (!body?.session_id || !body?.lines || !body?.payments) {
    return fail("validation", "session_id, lines, and payments are required", 422, { requestId });
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema("finance").rpc("create_sale_atomic", {
    p_session_id: body.session_id,
    p_lines: body.lines,
    p_payments: body.payments,
    p_partner_id: body.partner_id ?? null,
    p_organization_id: activeOrg.orgId,
  });

  if (error) return fail("rpc_error", error.message, 500, { requestId });
  return ok(data, { status: 201, requestId });
}
