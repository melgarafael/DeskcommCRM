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
  const isActive = url.searchParams.get("is_active");
  const appliesTo = url.searchParams.get("applies_to");

  const supabase = await createClient();
  let query = supabase
    .from("finance_discounts")
    .select("*")
    .eq("organization_id", activeOrg.orgId)
    .order("created_at", { ascending: false });

  if (isActive !== null) query = query.eq("is_active", isActive === "true");
  if (appliesTo) query = query.eq("applies_to", appliesTo);

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
  if (!body?.name || !body?.discount_type || body?.value === undefined) {
    return fail("validation", "name, discount_type, and value are required", 422, { requestId });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("finance_discounts")
    .insert({
      organization_id: activeOrg.orgId,
      name: body.name,
      discount_type: body.discount_type,
      value: body.value,
      applies_to: body.applies_to ?? "sale",
      promo_code: body.promo_code?.toUpperCase().trim() ?? null,
      is_active: body.is_active ?? true,
      valid_from: body.valid_from ?? null,
      valid_until: body.valid_until ?? null,
      max_uses: body.max_uses ?? null,
      current_uses: 0,
      min_purchase: body.min_purchase ?? 0,
    })
    .select()
    .single();

  if (error) return fail("db_error", error.message, 500, { requestId });
  return ok(data, { status: 201, requestId });
}
