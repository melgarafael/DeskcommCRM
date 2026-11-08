import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/* GET /api/v1/pos/payment-methods — list payment methods */
export async function GET(req: Request): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "pos" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("finance_payment_methods")
    .select("*")
    .eq("organization_id", activeOrg.orgId)
    .order("name");

  if (error) return fail("db_error", error.message, 500, { requestId });
  return ok(data, { requestId });
}

/* POST /api/v1/pos/payment-methods — create payment method */
export async function POST(req: Request): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "pos" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const body = await req.json().catch(() => null);
  if (!body?.name || !body?.type) {
    return fail("validation", "name and type are required", 422, { requestId });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("finance_payment_methods")
    .insert({
      name: body.name,
      type: body.type,
      is_active: body.is_active ?? true,
      organization_id: activeOrg.orgId,
    })
    .select()
    .single();

  if (error) return fail("db_error", error.message, 500, { requestId });
  return ok(data, { status: 201, requestId });
}
