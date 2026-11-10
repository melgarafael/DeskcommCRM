import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type CommissionConfig = { default_pct?: number; fixed_amount?: number };

export async function POST(req: Request): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "pos" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const body = await req.json().catch(() => null);
  const period = body?.period;

  if (!period || !/^\d{4}-\d{2}$/.test(period)) {
    return fail("validation", "period (YYYY-MM) is required", 422, { requestId });
  }

  const [year, month] = period.split("-");
  const startDate = `${period}-01`;
  const endDate = new Date(parseInt(year), parseInt(month), 0).toISOString().split("T")[0];

  const supabase = await createClient();

  const { data: configs } = await supabase
    .from("finance_professional_configs")
    .select("member_id, commission_type, commission_config")
    .eq("organization_id", activeOrg.orgId)
    .eq("is_active", true);

  const configMap: Record<string, { commission_type: string; commission_config: CommissionConfig }> = {};
  for (const c of configs ?? []) {
    configMap[c.member_id] = { commission_type: c.commission_type, commission_config: c.commission_config as CommissionConfig };
  }

  const { data: lines, error: linesErr } = await supabase
    .from("finance_sale_lines")
    .select("id, line_total, commission_amount, professional_id, finance_sales!inner(created_at, state)")
    .gte("finance_sales.created_at", `${startDate}T00:00:00`)
    .lte("finance_sales.created_at", `${endDate}T23:59:59.999`)
    .neq("finance_sales.state", "cancelled")
    .not("professional_id", "is", null)
    .is("commission_amount", null);

  if (linesErr) return fail("db_error", linesErr.message, 500, { requestId });

  let updated = 0;
  for (const line of lines ?? []) {
    const profId = line.professional_id as string;
    const cfg = configMap[profId];
    if (!cfg) continue;

    let amount = 0;
    const lineTotal = (line.line_total as number) ?? 0;
    if (cfg.commission_type === "percentage" || cfg.commission_type === "tiered") {
      amount = Math.round(lineTotal * (cfg.commission_config.default_pct ?? 0) / 100 * 100) / 100;
    } else if (cfg.commission_type === "fixed") {
      amount = cfg.commission_config.fixed_amount ?? 0;
    }

    if (amount > 0) {
      await supabase
        .from("finance_sale_lines")
        .update({ commission_amount: amount })
        .eq("id", line.id);
      updated++;
    }
  }

  return ok({
    period,
    lines_processed: (lines ?? []).length,
    lines_updated: updated,
  }, { requestId });
}
