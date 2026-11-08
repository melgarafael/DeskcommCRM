import { randomUUID } from "node:crypto";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "finance" });
  if (!authz.ok) return authz.response;

  const body = await req.json().catch(() => null);
  if (!body?.base || !body?.tax_config_id) {
    return fail("validation_error", "base and tax_config_id are required", 400, { requestId });
  }

  if (typeof body.base !== "number" || body.base < 0) {
    return fail("validation_error", "base must be a non-negative number", 400, { requestId });
  }

  const supabase = await createClient();

  // Single tax config
  if (!body.tax_config_ids) {
    const { data, error } = await supabase
      .schema("finance")
      .rpc("compute_tax", { p_base: body.base, p_tax_config_id: body.tax_config_id });

    if (error) return fail("internal_error", "Failed to compute tax", 500, { requestId });
    return ok({ tax_amount: data }, { requestId });
  }

  // Multiple tax configs
  if (!Array.isArray(body.tax_config_ids)) {
    return fail("validation_error", "tax_config_ids must be an array of uuids", 400, { requestId });
  }

  const { data, error } = await supabase
    .schema("finance")
    .rpc("compute_tax_multi", { p_base: body.base, p_tax_config_ids: body.tax_config_ids });

  if (error) return fail("internal_error", "Failed to compute taxes", 500, { requestId });
  return ok(data, { requestId });
}
