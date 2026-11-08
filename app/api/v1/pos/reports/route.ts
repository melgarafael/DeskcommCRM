import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/* GET /api/v1/pos/reports?type=daily|by_payment_method|tax_summary */
export async function GET(req: Request): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "pos" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const url = new URL(req.url);
  const type = url.searchParams.get("type");

  if (!type || !["daily", "by_payment_method", "tax_summary"].includes(type)) {
    return fail(
      "validation",
      "type param required: daily | by_payment_method | tax_summary",
      422,
      { requestId },
    );
  }

  const viewMap: Record<string, string> = {
    daily: "finance_v_daily_sales_report",
    by_payment_method: "finance_v_sales_by_payment_method",
    tax_summary: "finance_v_tax_summary",
  };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from(viewMap[type]!)
    .select("*")
    .eq("organization_id", activeOrg.orgId);

  if (error) return fail("db_error", error.message, 500, { requestId });
  return ok(data, { requestId });
}
