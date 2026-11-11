import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/* GET /api/v1/pos/returns — list returns */
export async function GET(req: Request): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "pos" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const url = new URL(req.url);
  const saleId = url.searchParams.get("sale_id");
  const state = url.searchParams.get("state");
  const dateFrom = url.searchParams.get("date_from");
  const dateTo = url.searchParams.get("date_to");

  const supabase = await createClient();
  let query = supabase
    .from("finance_pos_returns")
    .select("*")
    .eq("organization_id", activeOrg.orgId)
    .order("created_at", { ascending: false });

  if (saleId) query = query.eq("sale_id", saleId);
  if (state) query = query.eq("state", state);
  if (dateFrom) query = query.gte("created_at", dateFrom);
  if (dateTo) query = query.lte("created_at", dateTo);

  const { data, error } = await query;
  if (error) return fail("db_error", error.message, 500, { requestId });
  return ok(data, { requestId });
}

/* POST /api/v1/pos/returns — create a return/refund */
export async function POST(req: Request): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "pos" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg, user } = authz;

  const body = await req.json().catch(() => null);
  if (!body?.sale_id || !body?.reason || !body?.refund_amount || !body?.refund_method) {
    return fail(
      "validation",
      "sale_id, reason, refund_amount and refund_method are required",
      422,
      { requestId },
    );
  }

  const supabase = await createClient();

  const { data: sale, error: saleErr } = await supabase
    .from("finance_sales")
    .select("id, number, state, total_amount")
    .eq("id", body.sale_id)
    .eq("organization_id", activeOrg.orgId)
    .single();

  if (saleErr || !sale) {
    return fail("not_found", "Sale not found", 404, { requestId });
  }

  if (sale.state === "cancelled" || sale.state === "draft") {
    return fail("validation", "Cannot refund a sale in state: " + sale.state, 422, { requestId });
  }

  if (body.refund_amount > sale.total_amount) {
    return fail("validation", "Refund amount exceeds sale total", 422, { requestId });
  }

  const returnNumber = `DEV-${Date.now().toString(36).toUpperCase()}`;

  const { data: ret, error: retErr } = await supabase
    .from("finance_pos_returns")
    .insert({
      return_number: returnNumber,
      sale_id: body.sale_id,
      session_id: body.session_id ?? null,
      reason: body.reason,
      refund_amount: body.refund_amount,
      refund_method: body.refund_method,
      state: "confirmed",
      notes: body.notes ?? null,
      organization_id: activeOrg.orgId,
      created_by: user.id,
    })
    .select()
    .single();

  if (retErr) return fail("db_error", retErr.message, 500, { requestId });

  if (body.lines && Array.isArray(body.lines) && body.lines.length > 0) {
    const lineRows = body.lines.map(
      (l: { sale_line_id?: string; product_name: string; quantity: number; unit_price: number }) => ({
        return_id: ret.id,
        sale_line_id: l.sale_line_id ?? null,
        product_name: l.product_name,
        quantity: l.quantity,
        unit_price: l.unit_price,
        line_total: l.quantity * l.unit_price,
        organization_id: activeOrg.orgId,
      }),
    );
    await supabase.from("finance_pos_return_lines").insert(lineRows);
  }

  if (body.refund_amount >= sale.total_amount) {
    await supabase
      .from("finance_sales")
      .update({ state: "refunded" })
      .eq("id", body.sale_id);
  }

  return ok(ret, { status: 201, requestId });
}
