import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/* POST /api/v1/pos/sales/:id/void — void sale via RPC */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "pos" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;
  const { id } = await params;

  const supabase = await createClient();
  const { data, error } = await supabase.schema("finance").rpc("void_sale", {
    p_sale_id: id,
    p_organization_id: activeOrg.orgId,
  });

  if (error) return fail("rpc_error", error.message, 500, { requestId });
  return ok(data, { requestId });
}
