import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(_req: Request): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "pos" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("finance_accounts_receivable")
    .select("*")
    .eq("organization_id", activeOrg.orgId)
    .neq("status", "paid")
    .order("due_date", { ascending: true });

  if (error) return fail("db_error", error.message, 500, { requestId });

  const today = new Date();
  const buckets = { current: 0, days_1_30: 0, days_31_60: 0, days_61_90: 0, over_90: 0 };
  const items: Record<string, typeof data> = { current: [], days_1_30: [], days_31_60: [], days_61_90: [], over_90: [] };

  for (const ar of data ?? []) {
    const due = new Date(ar.due_date);
    const diffDays = Math.floor((today.getTime() - due.getTime()) / (1000 * 60 * 60 * 24));
    const balance = ar.balance ?? 0;

    let bucket: keyof typeof buckets;
    if (diffDays <= 0) bucket = "current";
    else if (diffDays <= 30) bucket = "days_1_30";
    else if (diffDays <= 60) bucket = "days_31_60";
    else if (diffDays <= 90) bucket = "days_61_90";
    else bucket = "over_90";

    buckets[bucket] += balance;
    items[bucket]!.push(ar);
  }

  const totalOutstanding = Object.values(buckets).reduce((a, b) => a + b, 0);

  return ok({ buckets, items, total_outstanding: totalOutstanding }, { requestId });
}
