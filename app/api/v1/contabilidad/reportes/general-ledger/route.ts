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
  const accountId = url.searchParams.get("account_id");
  const startDate = url.searchParams.get("startDate");
  const endDate = url.searchParams.get("endDate");
  const limit = parseInt(url.searchParams.get("limit") || "200");

  let query = supabase
    .from("finance_v_ledger")
    .select("*")
    .eq("organization_id", activeOrg.orgId)
    .order("entry_date", { ascending: true })
    .order("entry_number", { ascending: true })
    .limit(limit);

  if (accountId) query = query.eq("account_id", accountId);
  if (startDate) query = query.gte("entry_date", startDate);
  if (endDate) query = query.lte("entry_date", endDate);

  const { data, error } = await query;
  if (error) return fail("internal", error.message, 500, { requestId });

  const { data: accounts, error: accErr } = await supabase
    .from("finance_chart_of_accounts")
    .select("id, code, name")
    .eq("organization_id", activeOrg.orgId)
    .eq("is_active", true)
    .order("code");

  if (accErr) return fail("internal", accErr.message, 500, { requestId });

  return ok({
    entries: data ?? [],
    accounts: accounts ?? [],
    filters: { account_id: accountId, startDate, endDate },
  }, { requestId });
}
