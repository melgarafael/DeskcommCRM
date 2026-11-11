import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "contabilidad" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const supabase = await createClient();

  const { data, error } = await supabase
    .from("finance_v_account_summary")
    .select("*")
    .eq("organization_id", activeOrg.orgId)
    .order("display_order")
    .order("type_code");

  if (error) return fail("internal", error.message, 500, { requestId });

  return ok(data ?? [], { requestId });
}
