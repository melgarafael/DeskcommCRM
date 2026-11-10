import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "pos" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;
  const { id } = await ctx.params;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("finance_discounts")
    .select("*")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .single();

  if (error) return fail("not_found", "Discount not found", 404, { requestId });
  return ok(data, { requestId });
}

export async function PUT(req: Request, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "pos" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;
  const { id } = await ctx.params;

  const body = await req.json().catch(() => null);
  if (!body) return fail("validation", "Body is required", 422, { requestId });

  const supabase = await createClient();
  const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const key of ["name", "discount_type", "value", "applies_to", "is_active", "valid_from", "valid_until", "max_uses", "min_purchase"]) {
    if (body[key] !== undefined) updateData[key] = body[key];
  }
  if (body.promo_code !== undefined) {
    updateData.promo_code = body.promo_code?.toUpperCase().trim() ?? null;
  }

  const { data, error } = await supabase
    .from("finance_discounts")
    .update(updateData)
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .select()
    .single();

  if (error) return fail("db_error", error.message, 500, { requestId });
  return ok(data, { requestId });
}

export async function DELETE(_req: Request, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "pos" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;
  const { id } = await ctx.params;

  const supabase = await createClient();
  const { error } = await supabase
    .from("finance_discounts")
    .delete()
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId);

  if (error) return fail("db_error", error.message, 500, { requestId });
  return ok({ deleted: true }, { requestId });
}
