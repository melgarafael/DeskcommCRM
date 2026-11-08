import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/* GET /api/v1/pos/configs — list POS configs */
export async function GET(req: Request): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "pos" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("finance_pos_configs")
    .select("*")
    .eq("organization_id", activeOrg.orgId)
    .order("name");

  if (error) return fail("db_error", error.message, 500, { requestId });
  return ok(data, { requestId });
}

/* POST /api/v1/pos/configs — create a POS config */
export async function POST(req: Request): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "pos" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const body = await req.json().catch(() => null);
  if (!body?.name) return fail("validation", "name is required", 422, { requestId });

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("finance_pos_configs")
    .insert({
      name: body.name,
      is_active: body.is_active ?? true,
      journal_id: body.journal_id ?? null,
      organization_id: activeOrg.orgId,
    })
    .select()
    .single();

  if (error) return fail("db_error", error.message, 500, { requestId });
  return ok(data, { status: 201, requestId });
}
