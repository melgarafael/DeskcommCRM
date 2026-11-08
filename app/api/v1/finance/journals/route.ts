import { randomUUID } from "node:crypto";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  name: z.string().min(1).max(255),
  type: z.string().min(1),
  code: z.string().min(1).max(10),
  default_debit_account_id: z.string().uuid().nullable().optional(),
  default_credit_account_id: z.string().uuid().nullable().optional(),
});

// GET /api/v1/finance/journals
export async function GET(req: Request): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "finance" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const { searchParams } = new URL(req.url);
  const type = searchParams.get("type");

  const supabase = await createClient();
  let query = supabase
    .from("finance_journals")
    .select("id, name, type, code, default_debit_account_id, default_credit_account_id, is_active, organization_id")
    .eq("organization_id", activeOrg.orgId)
    .order("code");

  if (type) query = query.eq("type", type);

  const { data, error } = await query;
  if (error) return fail("internal_error", error.message, 500, { requestId });

  return ok(data ?? [], { requestId });
}

// POST /api/v1/finance/journals
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
    .from("finance_journals")
    .insert({ ...parsed.data, organization_id: activeOrg.orgId })
    .select()
    .single();

  if (error) return fail("internal_error", error.message, 500, { requestId });

  return ok(data, { status: 201, requestId });
}
