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
    .from("finance_gift_cards")
    .select("*, finance_gift_card_transactions(*)")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .single();

  if (error) return fail("not_found", "Gift card not found", 404, { requestId });
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
  for (const key of ["status", "assigned_to", "expires_at", "notes"]) {
    if (body[key] !== undefined) updateData[key] = body[key];
  }

  const { data, error } = await supabase
    .from("finance_gift_cards")
    .update(updateData)
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .select()
    .single();

  if (error) return fail("db_error", error.message, 500, { requestId });
  return ok(data, { requestId });
}
