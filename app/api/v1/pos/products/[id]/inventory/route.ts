import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "pos" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;
  const { id } = await ctx.params;

  const body = await req.json().catch(() => null);
  if (body?.adjustment === undefined) {
    return fail("validation", "adjustment (number) is required", 422, { requestId });
  }

  const supabase = await createClient();

  const { data: product } = await supabase
    .from("finance_products")
    .select("stock_quantity")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .single();

  if (!product) return fail("not_found", "Product not found", 404, { requestId });

  const newQty = (product.stock_quantity ?? 0) + body.adjustment;
  if (newQty < 0) {
    return fail("validation", "Stock cannot go below 0", 422, { requestId });
  }

  const { data, error } = await supabase
    .from("finance_products")
    .update({ stock_quantity: newQty, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .select()
    .single();

  if (error) return fail("db_error", error.message, 500, { requestId });
  return ok(data, { requestId });
}
