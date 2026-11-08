import { randomUUID } from "node:crypto";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  code: z.string().min(1).max(20),
  name: z.string().min(1).max(255),
  account_type: z.string().min(1),
  reconcile: z.boolean().optional().default(false),
  parent_id: z.string().uuid().nullable().optional(),
});

// GET /api/v1/finance/chart-of-accounts
export async function GET(req: Request): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "finance" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const { searchParams } = new URL(req.url);
  const accountType = searchParams.get("account_type");
  const isActive = searchParams.get("is_active");
  const parentId = searchParams.get("parent_id");

  const supabase = await createClient();
  let query = supabase
    .from("finance_chart_of_accounts")
    .select("id, code, name, account_type, parent_id, is_active, reconcile, organization_id")
    .eq("organization_id", activeOrg.orgId)
    .order("code");

  if (accountType) query = query.eq("account_type", accountType);
  if (isActive !== null) query = query.eq("is_active", isActive === "true");
  if (parentId) query = query.eq("parent_id", parentId);

  const { data, error } = await query;
  if (error) return fail("internal_error", error.message, 500, { requestId });

  return ok(data ?? [], { requestId });
}

// POST /api/v1/finance/chart-of-accounts
export async function POST(req: Request): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "finance" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("validation_error", "Invalid JSON body", 400, { requestId });
  }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return fail("validation_error", "Invalid request body", 400, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("finance_chart_of_accounts")
    .insert({ ...parsed.data, organization_id: activeOrg.orgId })
    .select()
    .single();

  if (error) return fail("internal_error", error.message, 500, { requestId });

  return ok(data, { status: 201, requestId });
}
