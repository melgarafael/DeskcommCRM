import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/* GET /api/v1/pos/configs/:id — single config with payment methods */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "pos" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;
  const { id } = await params;

  const supabase = await createClient();

  const { data: config, error } = await supabase
    .from("finance_pos_configs")
    .select("*")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .single();

  if (error || !config) return fail("not_found", "Config not found", 404, { requestId });

  const { data: methods } = await supabase
    .from("finance_pos_config_payment_methods")
    .select("payment_method_id, finance_payment_methods(*)")
    .eq("pos_config_id", id)
    .eq("organization_id", activeOrg.orgId);

  return ok({ ...config, payment_methods: methods ?? [] }, { requestId });
}

/* PATCH /api/v1/pos/configs/:id — update config */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "pos" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;
  const { id } = await params;

  const body = await req.json().catch(() => null);
  if (!body) return fail("validation", "Body is required", 422, { requestId });

  const supabase = await createClient();

  const allowed: Record<string, unknown> = {};
  if (body.name !== undefined) allowed.name = body.name;
  if (body.is_active !== undefined) allowed.is_active = body.is_active;
  if (body.journal_id !== undefined) allowed.journal_id = body.journal_id;

  if (Object.keys(allowed).length === 0) {
    return fail("validation", "No fields to update", 422, { requestId });
  }

  const { data, error } = await supabase
    .from("finance_pos_configs")
    .update(allowed)
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .select()
    .single();

  if (error || !data) return fail("not_found", "Config not found", 404, { requestId });
  return ok(data, { requestId });
}
