import { randomUUID } from "node:crypto";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "finance" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;
  const { id } = await params;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("finance_tax_configs")
    .select("id, name, type_name, amount, tax_group_id, parent_id, is_active, organization_id")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .single();

  if (error || !data) return fail("not_found", "Tax config not found", 404, { requestId });
  return ok(data, { requestId });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "finance" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;
  const { id } = await params;

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return fail("validation_error", "Request body is required", 400, { requestId });
  }

  const allowed = ["name", "type_name", "amount", "tax_group_id", "parent_id", "is_active"] as const;
  const updates: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in body) updates[key] = body[key];
  }

  if (Object.keys(updates).length === 0) {
    return fail("validation_error", "No valid fields to update", 400, { requestId });
  }

  if (updates.type_name) {
    const validTypes = ["division", "percentage", "group"];
    if (!validTypes.includes(updates.type_name as string)) {
      return fail("validation_error", `type_name must be one of: ${validTypes.join(", ")}`, 400, { requestId });
    }
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("finance_tax_configs")
    .update(updates)
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .select("id, name, type_name, amount, tax_group_id, parent_id, is_active, organization_id")
    .single();

  if (error || !data) return fail("not_found", "Tax config not found", 404, { requestId });
  return ok(data, { requestId });
}
