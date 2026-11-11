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
  const startDate = url.searchParams.get("startDate");
  const endDate = url.searchParams.get("endDate");

  if (startDate || endDate) {
    const { data, error } = await supabase.rpc("get_trial_balance_by_date", {
      p_start_date: startDate || null,
      p_end_date: endDate || null,
    });

    if (error) return fail("internal", error.message, 500, { requestId });

    const rows = (data ?? []) as { code: string; name: string; account_type: string; increases_on: string; total_debit: number; total_credit: number; balance: number }[];
    const totalDebit = rows.reduce((s, r) => s + r.total_debit, 0);
    const totalCredit = rows.reduce((s, r) => s + r.total_credit, 0);

    return ok({ data: rows, totals: { totalDebit, totalCredit }, is_balanced: Math.abs(totalDebit - totalCredit) < 0.01 }, { requestId });
  }

  const { data, error } = await supabase
    .from("finance_v_trial_balance")
    .select("*")
    .eq("organization_id", activeOrg.orgId)
    .order("code");

  if (error) return fail("internal", error.message, 500, { requestId });

  const rows = data ?? [];
  const totalDebit = rows.reduce((s: number, r: { total_debit: number }) => s + r.total_debit, 0);
  const totalCredit = rows.reduce((s: number, r: { total_credit: number }) => s + r.total_credit, 0);

  return ok({ data: rows, totals: { totalDebit, totalCredit }, is_balanced: Math.abs(totalDebit - totalCredit) < 0.01 }, { requestId });
}
