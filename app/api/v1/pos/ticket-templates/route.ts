import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/* GET /api/v1/pos/ticket-templates — list templates */
export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "pos" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("finance_pos_ticket_templates")
    .select("*")
    .eq("organization_id", activeOrg.orgId)
    .order("is_default", { ascending: false })
    .order("created_at", { ascending: false });

  if (error) return fail("query_error", error.message, 500, { requestId });
  return ok(data ?? [], { requestId });
}

/* POST /api/v1/pos/ticket-templates — create template */
export async function POST(req: Request): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "pos" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg, user } = authz;

  const body = await req.json();
  const {
    name,
    business_name,
    tax_id,
    address,
    phone,
    logo_url,
    header_text,
    footer_text,
    show_tax_breakdown,
    show_payment_method,
    show_cashier,
    show_date_time,
    show_client,
    paper_size,
    is_default,
  } = body;

  if (!name) return fail("validation", "name is required", 400, { requestId });

  const supabase = await createClient();

  if (is_default) {
    await supabase
      .from("finance_pos_ticket_templates")
      .update({ is_default: false })
      .eq("organization_id", activeOrg.orgId)
      .eq("is_default", true);
  }

  const { data, error } = await supabase
    .from("finance_pos_ticket_templates")
    .insert({
      name,
      business_name: business_name ?? null,
      tax_id: tax_id ?? null,
      address: address ?? null,
      phone: phone ?? null,
      logo_url: logo_url ?? null,
      header_text: header_text ?? null,
      footer_text: footer_text ?? "Gracias por su compra",
      show_tax_breakdown: show_tax_breakdown ?? true,
      show_payment_method: show_payment_method ?? true,
      show_cashier: show_cashier ?? true,
      show_date_time: show_date_time ?? true,
      show_client: show_client ?? true,
      paper_size: paper_size ?? "80mm",
      is_default: is_default ?? false,
      organization_id: activeOrg.orgId,
      created_by: user.id,
    })
    .select()
    .single();

  if (error) return fail("insert_error", error.message, 500, { requestId });
  return ok(data, { requestId, status: 201 });
}

/* PATCH /api/v1/pos/ticket-templates — update template (id in body) */
export async function PATCH(req: Request): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "pos" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const body = await req.json();
  const { id, ...fields } = body;
  if (!id) return fail("validation", "id is required", 400, { requestId });

  const supabase = await createClient();

  if (fields.is_default) {
    await supabase
      .from("finance_pos_ticket_templates")
      .update({ is_default: false })
      .eq("organization_id", activeOrg.orgId)
      .eq("is_default", true);
  }

  const { data, error } = await supabase
    .from("finance_pos_ticket_templates")
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .select()
    .single();

  if (error) return fail("update_error", error.message, 500, { requestId });
  return ok(data, { requestId });
}
