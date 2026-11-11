import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "contabilidad" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const supabase = await createClient();
  const url = new URL(req.url);
  const year = parseInt(url.searchParams.get("year") || String(new Date().getFullYear()));

  const { data, error } = await supabase
    .from("finance_monthly_budgets")
    .select("*")
    .eq("organization_id", activeOrg.orgId)
    .eq("year", year)
    .order("month", { ascending: true });

  if (error) return fail("internal", error.message, 500, { requestId });

  return ok(data ?? [], { requestId });
}

export async function POST(req: Request): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "contabilidad" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg, user } = authz;

  const supabase = await createClient();

  let body: { year?: number; month?: number; budgeted_amount?: number; notes?: string };
  try {
    body = await req.json();
  } catch {
    return fail("validation", "Invalid JSON body", 400, { requestId });
  }

  const { year, month, budgeted_amount, notes } = body;
  if (!year || !month || budgeted_amount === undefined || budgeted_amount === null)
    return fail("validation", "year, month, and budgeted_amount are required", 400, { requestId });
  if (month < 1 || month > 12)
    return fail("validation", "month must be between 1 and 12", 400, { requestId });
  if (budgeted_amount < 0)
    return fail("validation", "budgeted_amount must be non-negative", 400, { requestId });

  const { data, error } = await supabase
    .from("finance_monthly_budgets")
    .upsert(
      {
        organization_id: activeOrg.orgId,
        year,
        month,
        category: "total_expenses",
        budgeted_amount,
        notes: notes || null,
        created_by: user.id,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "organization_id,year,month,category" },
    )
    .select();

  if (error) return fail("internal", error.message, 500, { requestId });

  return ok(data?.[0] ?? { year, month, budgeted_amount }, { requestId });
}
