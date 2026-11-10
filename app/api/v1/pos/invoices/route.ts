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
  const status = url.searchParams.get("status");
  const contactId = url.searchParams.get("contact_id");
  const dateFrom = url.searchParams.get("date_from");
  const dateTo = url.searchParams.get("date_to");

  const supabase = await createClient();
  let query = supabase
    .from("finance_invoices")
    .select("*")
    .eq("organization_id", activeOrg.orgId)
    .order("created_at", { ascending: false });

  if (status) query = query.eq("status", status);
  if (contactId) query = query.eq("customer_nit", contactId);
  if (dateFrom) query = query.gte("invoice_date", dateFrom);
  if (dateTo) query = query.lte("invoice_date", dateTo);

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
  if (!body?.invoice_number || !body?.total) {
    return fail("validation", "invoice_number and total are required", 422, { requestId });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("finance_invoices")
    .insert({
      organization_id: activeOrg.orgId,
      sale_id: body.sale_id ?? null,
      invoice_number: body.invoice_number,
      invoice_date: body.invoice_date ?? new Date().toISOString().split("T")[0],
      customer_name: body.customer_name ?? null,
      customer_nit: body.customer_nit ?? null,
      subtotal: body.subtotal ?? 0,
      tax_total: body.tax_total ?? 0,
      total: body.total,
      status: body.status ?? "draft",
      notes: body.notes ?? null,
    })
    .select()
    .single();

  if (error) return fail("db_error", error.message, 500, { requestId });
  return ok(data, { status: 201, requestId });
}
