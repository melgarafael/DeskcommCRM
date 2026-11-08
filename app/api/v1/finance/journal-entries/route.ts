import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// GET /api/v1/finance/journal-entries
export async function GET(req: Request): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "finance" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const { searchParams } = new URL(req.url);
  const state = searchParams.get("state");
  const journalId = searchParams.get("journal_id");
  const moveType = searchParams.get("move_type");
  const dateFrom = searchParams.get("date_from");
  const dateTo = searchParams.get("date_to");
  const limit = Math.min(Number(searchParams.get("limit") ?? "50") || 50, 200);

  const supabase = await createClient();
  let query = supabase
    .from("finance_journal_entries")
    .select("id, journal_id, number, date, ref, partner_id, move_type, state, payment_state, amount_total, organization_id")
    .eq("organization_id", activeOrg.orgId)
    .order("date", { ascending: false })
    .limit(limit);

  if (state) query = query.eq("state", state);
  if (journalId) query = query.eq("journal_id", journalId);
  if (moveType) query = query.eq("move_type", moveType);
  if (dateFrom) query = query.gte("date", dateFrom);
  if (dateTo) query = query.lte("date", dateTo);

  const { data, error } = await query;
  if (error) return fail("internal_error", error.message, 500, { requestId });

  return ok(data ?? [], { requestId, meta: { has_more: (data?.length ?? 0) === limit } });
}
