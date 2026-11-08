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

  const { searchParams } = new URL(req.url);
  const isActive = searchParams.get("is_active");
  const typeName = searchParams.get("type_name");

  const supabase = await createClient();
  let query = supabase
    .from("finance_tax_configs")
    .select("id, name, type_name, amount, tax_group_id, parent_id, is_active, organization_id")
    .eq("organization_id", activeOrg.orgId)
    .order("name");

  if (isActive !== null) query = query.eq("is_active", isActive === "true");
  if (typeName) query = query.eq("type_name", typeName);

  const { data, error } = await query;
  if (error) return fail("internal_error", "Failed to fetch tax configs", 500, { requestId });
  return ok(data, { requestId });
}

export async function POST(req: Request): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "finance" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const body = await req.json().catch(() => null);
  if (!body?.name || !body?.type_name) {
    return fail("validation_error", "name and type_name are required", 400, { requestId });
  }

  const validTypes = ["division", "percentage", "group"];
  if (!validTypes.includes(body.type_name)) {
    return fail("validation_error", `type_name must be one of: ${validTypes.join(", ")}`, 400, { requestId });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("finance_tax_configs")
    .insert({
      name: body.name,
      type_name: body.type_name,
      amount: body.amount ?? 0,
      tax_group_id: body.tax_group_id ?? null,
      parent_id: body.parent_id ?? null,
      is_active: body.is_active ?? true,
      organization_id: activeOrg.orgId,
    })
    .select("id, name, type_name, amount, tax_group_id, parent_id, is_active, organization_id")
    .single();

  if (error) return fail("internal_error", "Failed to create tax config", 500, { requestId });
  return ok(data, { requestId, status: 201 });
}
