import { randomUUID } from "node:crypto";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(_req: Request): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "finance" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("finance_v_bank_statement_balances")
    .select("*")
    .eq("organization_id", activeOrg.orgId);

  if (error) return fail("db_error", error.message, 500, { requestId });

  return ok(data, { requestId });
}
