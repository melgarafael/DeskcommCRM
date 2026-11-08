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

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("finance_tax_groups")
    .select("id, name, organization_id")
    .eq("organization_id", activeOrg.orgId)
    .order("name");

  if (error) return fail("internal_error", "Failed to fetch tax groups", 500, { requestId });
  return ok(data, { requestId });
}

export async function POST(req: Request): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "finance" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const body = await req.json().catch(() => null);
  if (!body?.name || typeof body.name !== "string") {
    return fail("validation_error", "name is required", 400, { requestId });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("finance_tax_groups")
    .insert({ name: body.name, organization_id: activeOrg.orgId })
    .select("id, name, organization_id")
    .single();

  if (error) return fail("internal_error", "Failed to create tax group", 500, { requestId });
  return ok(data, { requestId, status: 201 });
}
