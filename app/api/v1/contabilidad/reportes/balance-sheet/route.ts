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

  const { data, error } = await supabase
    .from("finance_v_trial_balance")
    .select("*")
    .eq("organization_id", activeOrg.orgId)
    .order("code");

  if (error) return fail("internal", error.message, 500, { requestId });

  const rows = (data ?? []) as { code: string; name: string; account_type: string; balance: number }[];

  const assets = rows.filter((r) => r.account_type.startsWith("asset_"));
  const liabilities = rows.filter((r) => r.account_type.startsWith("liability_"));
  const equity = rows.filter((r) => r.account_type.startsWith("equity"));

  const totalAssets = assets.reduce((s, r) => s + r.balance, 0);
  const totalLiabilities = liabilities.reduce((s, r) => s + r.balance, 0);
  const totalEquity = equity.reduce((s, r) => s + r.balance, 0);

  return ok({
    sections: {
      assets: { items: assets, total: totalAssets },
      liabilities: { items: liabilities, total: totalLiabilities },
      equity: { items: equity, total: totalEquity },
    },
    is_balanced: Math.abs(totalAssets - totalLiabilities - totalEquity) < 0.01,
  }, { requestId });
}
