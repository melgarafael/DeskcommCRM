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
  const category = url.searchParams.get("category");
  const isActive = url.searchParams.get("is_active");
  const search = url.searchParams.get("search");
  const lowStock = url.searchParams.get("low_stock");

  const supabase = await createClient();
  let query = supabase
    .from("finance_products")
    .select("*")
    .eq("organization_id", activeOrg.orgId)
    .order("name", { ascending: true });

  if (category) query = query.eq("category", category);
  if (isActive !== null) query = query.eq("is_active", isActive === "true");
  if (search) query = query.ilike("name", `%${search}%`);
  if (lowStock === "true") query = query.eq("track_stock", true).lt("stock_quantity", 10);

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
  if (!body?.name || body?.sale_price === undefined) {
    return fail("validation", "name and sale_price are required", 422, { requestId });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("finance_products")
    .insert({
      organization_id: activeOrg.orgId,
      name: body.name,
      sku: body.sku ?? null,
      description: body.description ?? null,
      category: body.category ?? null,
      sale_price: body.sale_price,
      cost_price: body.cost_price ?? 0,
      tax_ids: body.tax_ids ?? [],
      is_active: body.is_active ?? true,
      track_stock: body.track_stock ?? false,
      stock_quantity: body.stock_quantity ?? 0,
      min_stock: body.min_stock ?? 0,
      image_url: body.image_url ?? null,
    })
    .select()
    .single();

  if (error) return fail("db_error", error.message, 500, { requestId });
  return ok(data, { status: 201, requestId });
}
