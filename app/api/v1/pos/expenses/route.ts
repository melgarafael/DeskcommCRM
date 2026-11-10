import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "pos" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const url = new URL(req.url);
  const category = url.searchParams.get("category");
  const dateFrom = url.searchParams.get("date_from");
  const dateTo = url.searchParams.get("date_to");

  const supabase = await createClient();
  let query = supabase
    .from("finance_expenses")
    .select("*")
    .eq("organization_id", activeOrg.orgId)
    .order("expense_date", { ascending: false });

  if (category) query = query.eq("category", category);
  if (dateFrom) query = query.gte("expense_date", dateFrom);
  if (dateTo) query = query.lte("expense_date", dateTo);

  const { data, error } = await query;
  if (error) return fail("db_error", error.message, 500, { requestId });
  return ok(data, { requestId });
}

export async function POST(req: Request): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "pos" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg, user } = authz;

  const body = await req.json().catch(() => null);
  if (!body?.description || !body?.amount) {
    return fail("validation", "description and amount are required", 422, { requestId });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("finance_expenses")
    .insert({
      organization_id: activeOrg.orgId,
      description: body.description,
      amount: body.amount,
      category: body.category ?? "general",
      expense_date: body.expense_date ?? new Date().toISOString().split("T")[0],
      payment_method: body.payment_method ?? null,
      notes: body.notes ?? null,
      created_by: user.id,
    })
    .select()
    .single();

  if (error) return fail("db_error", error.message, 500, { requestId });
  return ok(data, { status: 201, requestId });
}
