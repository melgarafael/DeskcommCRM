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
  const now = new Date();
  const year = parseInt(url.searchParams.get("year") || String(now.getFullYear()));
  const month = parseInt(url.searchParams.get("month") || String(now.getMonth() + 1));

  const { data: currentData, error: err1 } = await supabase
    .from("finance_v_monthly_pnl")
    .select("*")
    .eq("organization_id", activeOrg.orgId)
    .eq("year", year)
    .eq("month", month)
    .limit(1);

  if (err1) return fail("internal", err1.message, 500, { requestId });

  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;

  const { data: prevData } = await supabase
    .from("finance_v_monthly_pnl")
    .select("*")
    .eq("organization_id", activeOrg.orgId)
    .eq("year", prevYear)
    .eq("month", prevMonth)
    .limit(1);

  const current = (currentData?.[0] as { revenue: number; expenses: number; net_income: number } | undefined) ?? { revenue: 0, expenses: 0, net_income: 0 };
  const prev = (prevData?.[0] as { revenue: number; expenses: number; net_income: number } | undefined) ?? null;

  return ok({
    period: { year, month },
    current: {
      revenue: current.revenue,
      expenses: current.expenses,
      gross_profit: current.revenue - current.expenses,
      net_income: current.net_income,
    },
    previous: prev ? {
      revenue: prev.revenue,
      expenses: prev.expenses,
      gross_profit: prev.revenue - prev.expenses,
      net_income: prev.net_income,
    } : null,
  }, { requestId });
}
