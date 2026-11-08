import { randomUUID } from "node:crypto";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "finance" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;
  const supabase = await createClient();

  const url = new URL(req.url);
  const journalId = url.searchParams.get("journal_id");
  const state = url.searchParams.get("state");
  const dateFrom = url.searchParams.get("date_from");
  const dateTo = url.searchParams.get("date_to");

  let query = supabase
    .from("finance_bank_statements")
    .select("*")
    .eq("organization_id", activeOrg.orgId)
    .order("date", { ascending: false });

  if (journalId) query = query.eq("journal_id", journalId);
  if (state) query = query.eq("state", state);
  if (dateFrom) query = query.gte("date", dateFrom);
  if (dateTo) query = query.lte("date", dateTo);

  const { data, error } = await query;
  if (error) return fail("db_error", error.message, 500, { requestId });

  return ok(data, { requestId });
}

export async function POST(req: Request): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "finance" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;
  const supabase = await createClient();

  const body = await req.json();

  const { data, error } = await supabase
    .from("finance_bank_statements")
    .insert({ ...body, organization_id: activeOrg.orgId })
    .select()
    .single();

  if (error) return fail("db_error", error.message, 500, { requestId });

  return ok(data, { status: 201, requestId });
}
