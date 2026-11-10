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
  const contactId = url.searchParams.get("contact_id");
  const status = url.searchParams.get("status");

  const supabase = await createClient();
  let query = supabase
    .from("finance_accounts_receivable")
    .select("*")
    .eq("organization_id", activeOrg.orgId)
    .order("due_date", { ascending: true });

  if (contactId) query = query.eq("contact_id", contactId);
  if (status) query = query.eq("status", status);

  const { data, error } = await query;
  if (error) return fail("db_error", error.message, 500, { requestId });
  return ok(data, { requestId });
}

export async function POST(req: Request): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "pos" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const body = await req.json().catch(() => null);
  if (!body?.amount || !body?.due_date) {
    return fail("validation", "amount and due_date are required", 422, { requestId });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("finance_accounts_receivable")
    .insert({
      organization_id: activeOrg.orgId,
      invoice_id: body.invoice_id ?? null,
      contact_id: body.contact_id ?? null,
      amount: body.amount,
      paid_amount: body.paid_amount ?? 0,
      balance: body.amount - (body.paid_amount ?? 0),
      due_date: body.due_date,
      status: body.status ?? "pending",
      notes: body.notes ?? null,
    })
    .select()
    .single();

  if (error) return fail("db_error", error.message, 500, { requestId });
  return ok(data, { status: 201, requestId });
}
