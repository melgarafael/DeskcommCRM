import { randomUUID } from "node:crypto";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function POST(_req: Request): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "finance" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const admin = createAdminClient();
  const { data, error } = await admin
    .schema("finance")
    .rpc("seed_fiscal_tags", { p_organization_id: activeOrg.orgId });

  if (error) return fail("internal_error", "Failed to seed fiscal tags", 500, { requestId });
  return ok({ seeded: true, result: data }, { requestId, status: 201 });
}
