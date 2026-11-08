import { randomUUID } from "node:crypto";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  type: z.string().min(1).optional(),
  code: z.string().min(1).max(10).optional(),
  default_debit_account_id: z.string().uuid().nullable().optional(),
  default_credit_account_id: z.string().uuid().nullable().optional(),
  is_active: z.boolean().optional(),
});

// GET /api/v1/finance/journals/[id]
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
    .from("finance_journals")
    .select("*")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .single();

  if (error) {
    if (error.code === "PGRST116") return fail("not_found", "Journal not found", 404, { requestId });
    return fail("internal_error", error.message, 500, { requestId });
  }

  return ok(data, { requestId });
}

// PATCH /api/v1/finance/journals/[id]
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
    .from("finance_journals")
    .update(parsed.data)
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .select()
    .single();

  if (error) {
    if (error.code === "PGRST116") return fail("not_found", "Journal not found", 404, { requestId });
    return fail("internal_error", error.message, 500, { requestId });
  }

  return ok(data, { requestId });
}
