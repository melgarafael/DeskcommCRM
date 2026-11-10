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
  const period = url.searchParams.get("period");

  if (!period || !/^\d{4}-\d{2}$/.test(period)) {
    return fail("validation", "period (YYYY-MM) is required", 422, { requestId });
  }

  const [year = "2024", month = "01"] = period.split("-");
  const startDate = `${period}-01`;
  const endDate = new Date(parseInt(year), parseInt(month), 0).toISOString().split("T")[0]!

  const supabase = await createClient();

  const { data: configs } = await supabase
    .from("finance_professional_configs")
    .select("member_id, commission_type, is_active")
    .eq("organization_id", activeOrg.orgId)
    .eq("is_active", true);

  const activeMembers = new Set((configs ?? []).map((c) => c.member_id));

  const { data: lines } = await supabase
    .from("finance_sale_lines")
    .select("professional_id, finance_sales!inner(created_at, state)")
    .gte("finance_sales.created_at", `${startDate}T00:00:00`)
    .lte("finance_sales.created_at", `${endDate}T23:59:59.999`)
    .neq("finance_sales.state", "cancelled")
    .not("professional_id", "is", null);

  const activeProfIds = new Set<string>();
  for (const l of lines ?? []) {
    if (l.professional_id) activeProfIds.add(l.professional_id as string);
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

  const utilization = [...activeMembers].map((id) => ({
    member_id: id,
    name: nameMap[id] ?? "Sin nombre",
    had_sales: activeProfIds.has(id),
  }));

  const withSales = utilization.filter((u) => u.had_sales).length;

  return ok({
    period,
    total_configured: activeMembers.size,
    with_sales: withSales,
    without_sales: activeMembers.size - withSales,
    utilization_pct: activeMembers.size > 0 ? Math.round((withSales / activeMembers.size) * 100) : 0,
    members: utilization,
  }, { requestId });
}
