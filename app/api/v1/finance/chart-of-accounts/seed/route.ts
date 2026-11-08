import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

// POST /api/v1/finance/chart-of-accounts/seed
// Seeds the Bolivia chart of accounts + journals via service_role RPC.
export async function POST(req: Request): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "finance" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const admin = createAdminClient();
  const { data, error } = await admin
    .schema("finance")
    .rpc("seed_bolivia_chart", { p_organization_id: activeOrg.orgId });

  if (error) return fail("internal_error", error.message, 500, { requestId });

  return ok(data ?? { seeded: true }, { status: 201, requestId });
}
