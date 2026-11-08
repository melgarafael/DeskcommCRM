import { randomUUID } from "node:crypto";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(
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
    .schema("finance")
    .rpc("auto_reconcile_statement", {
      p_statement_id: id,
      p_organization_id: activeOrg.orgId,
    });

  if (error) return fail("db_error", error.message, 500, { requestId });

  return ok(data, { requestId });
}
