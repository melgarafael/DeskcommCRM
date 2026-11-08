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
  const supabase = await createClient();

  const { id } = await params;

  const { data, error } = await supabase
    .from("finance_bank_statements")
    .select("*")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .single();

  if (error) {
    if (error.code === "PGRST116") return fail("not_found", "Statement not found", 404, { requestId });
    return fail("db_error", error.message, 500, { requestId });
  }

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
  const supabase = await createClient();

  const { id } = await params;
  const body = await req.json();

  const { data, error } = await supabase
    .from("finance_bank_statements")
    .update(body)
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .select()
    .single();

  if (error) {
    if (error.code === "PGRST116") return fail("not_found", "Statement not found", 404, { requestId });
    return fail("db_error", error.message, 500, { requestId });
  }

  return ok(data, { requestId });
}
