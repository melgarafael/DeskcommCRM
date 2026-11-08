import { randomUUID } from "node:crypto";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const viewMap: Record<string, string> = {
  receivable: "finance_v_accounts_receivable",
  payable: "finance_v_accounts_payable",
};

export async function GET(req: Request): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "finance" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const { searchParams } = new URL(req.url);
  const type = searchParams.get("type");
  if (!type || !viewMap[type]) {
    return fail("validation_error", "type must be 'receivable' or 'payable'", 400, { requestId });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from(viewMap[type]!)
    .select("*")
    .eq("organization_id", activeOrg.orgId);

  if (error) return fail("internal_error", `Failed to fetch ${type} report`, 500, { requestId });
  return ok(data, { requestId });
}
