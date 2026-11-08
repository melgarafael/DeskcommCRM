import { randomUUID } from "node:crypto";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  code: z.string().min(1).max(20).optional(),
  name: z.string().min(1).max(255).optional(),
  account_type: z.string().min(1).optional(),
  reconcile: z.boolean().optional(),
  parent_id: z.string().uuid().nullable().optional(),
  is_active: z.boolean().optional(),
});

// GET /api/v1/finance/chart-of-accounts/[id]
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "finance" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;
  const { id } = await params;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("finance_chart_of_accounts")
    .select("*")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .single();

  if (error) {
    if (error.code === "PGRST116") return fail("not_found", "Account not found", 404, { requestId });
    return fail("internal_error", error.message, 500, { requestId });
  }

  return ok(data, { requestId });
}

// PATCH /api/v1/finance/chart-of-accounts/[id]
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "finance" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;
  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("validation_error", "Invalid JSON body", 400, { requestId });
  }

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return fail("validation_error", "Invalid request body", 400, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("finance_chart_of_accounts")
    .update(parsed.data)
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .select()
    .single();

  if (error) {
    if (error.code === "PGRST116") return fail("not_found", "Account not found", 404, { requestId });
    return fail("internal_error", error.message, 500, { requestId });
  }

  return ok(data, { requestId });
}

// DELETE /api/v1/finance/chart-of-accounts/[id] — soft-delete
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "finance" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;
  const { id } = await params;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("finance_chart_of_accounts")
    .update({ is_active: false })
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .select()
    .single();

  if (error) {
    if (error.code === "PGRST116") return fail("not_found", "Account not found", 404, { requestId });
    return fail("internal_error", error.message, 500, { requestId });
  }

  return ok(data, { requestId });
}
