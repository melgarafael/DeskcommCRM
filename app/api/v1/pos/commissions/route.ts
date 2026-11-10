import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type CommissionConfig = { default_pct?: number; fixed_amount?: number };

function calculateCommission(itemTotal: number, cType: string | null, cConfig: CommissionConfig | null): number {
  if (!cType || !cConfig) return 0;
  if (cType === "percentage" || cType === "tiered") {
    return Math.round(itemTotal * (cConfig.default_pct ?? 0) / 100 * 100) / 100;
  }
  if (cType === "fixed") return cConfig.fixed_amount ?? 0;
  return 0;
}

function formatRate(cType: string | null, cConfig: CommissionConfig | null): string {
  if (!cType || !cConfig) return "—";
  if (cType === "percentage" || cType === "tiered") return `${cConfig.default_pct ?? 0}%`;
  if (cType === "fixed") return `Bs. ${(cConfig.fixed_amount ?? 0).toFixed(2)}`;
  return "—";
}

export async function GET(req: Request): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "pos" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const url = new URL(req.url);
  const period = url.searchParams.get("period");
  const memberId = url.searchParams.get("member_id");

  if (!period || !/^\d{4}-\d{2}$/.test(period)) {
    return fail("validation", "period (YYYY-MM) is required", 422, { requestId });
  }

  const [year = "2024", month = "01"] = period.split("-");
  const startDate = `${period}-01`;
  const endDate = new Date(parseInt(year), parseInt(month), 0).toISOString().split("T")[0]!

  const supabase = await createClient();

  let linesQuery = supabase
    .from("finance_sale_lines")
    .select("id, sale_id, item_name, item_type, quantity, unit_price, line_total, commission_amount, professional_id, finance_sales!inner(id, sale_number, state, created_at)")
    .gte("finance_sales.created_at", `${startDate}T00:00:00`)
    .lte("finance_sales.created_at", `${endDate}T23:59:59.999`)
    .neq("finance_sales.state", "cancelled")
    .not("professional_id", "is", null);

  if (memberId) linesQuery = linesQuery.eq("professional_id", memberId);

  const { data: items, error: itemsErr } = await linesQuery;
  if (itemsErr) return fail("db_error", itemsErr.message, 500, { requestId });

  const { data: configs } = await supabase
    .from("finance_professional_configs")
    .select("member_id, commission_type, commission_config")
    .eq("organization_id", activeOrg.orgId)
    .eq("is_active", true);

  const configMap: Record<string, { commission_type: string | null; commission_config: CommissionConfig | null }> = {};
  for (const c of configs ?? []) {
    configMap[c.member_id] = { commission_type: c.commission_type, commission_config: c.commission_config as CommissionConfig };
  }

  const { data: members } = await supabase
    .from("organization_members")
    .select("user_id, users(full_name)")
    .eq("organization_id", activeOrg.orgId);

  const nameMap: Record<string, string> = {};
  for (const m of members ?? []) {
    const user = (m as Record<string, unknown>).users as Record<string, unknown> | null;
    nameMap[m.user_id] = (user?.full_name as string) ?? "Sin nombre";
  }

  const byProf: Record<string, { id: string; name: string; rate: string; totalSales: number; totalCommission: number; count: number }> = {};

  for (const item of items ?? []) {
    const profId = item.professional_id as string;
    if (!profId) continue;

    if (!byProf[profId]) {
      const cfg = configMap[profId];
      byProf[profId] = {
        id: profId,
        name: nameMap[profId] ?? "Sin nombre",
        rate: formatRate(cfg?.commission_type ?? null, cfg?.commission_config ?? null),
        totalSales: 0,
        totalCommission: 0,
        count: 0,
      };
    }

    const lineTotal = (item.line_total as number) ?? 0;
    let commAmount = (item.commission_amount as number) ?? 0;
    if (!commAmount) {
      const cfg = configMap[profId];
      commAmount = calculateCommission(lineTotal, cfg?.commission_type ?? null, cfg?.commission_config ?? null);
    }

    byProf[profId].totalSales += lineTotal;
    byProf[profId].totalCommission += commAmount;
    byProf[profId].count++;
  }

  const result = Object.values(byProf)
    .map((c) => ({ ...c, totalSales: Math.round(c.totalSales * 100) / 100, totalCommission: Math.round(c.totalCommission * 100) / 100 }))
    .sort((a, b) => b.totalCommission - a.totalCommission);

  return ok(result, {
    requestId,
    meta: {
      period,
      total_commissions: result.reduce((s, r) => s + r.totalCommission, 0),
      total_sales: result.reduce((s, r) => s + r.totalSales, 0),
    },
  });
}
