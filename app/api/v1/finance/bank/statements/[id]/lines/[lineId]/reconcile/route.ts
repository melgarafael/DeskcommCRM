import { randomUUID } from "node:crypto";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; lineId: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "finance" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;
  const supabase = await createClient();

  const { lineId } = await params;
  const body = await req.json();
  const entryLineIds: string[] = body.entry_line_ids;

  if (!Array.isArray(entryLineIds) || entryLineIds.length === 0) {
    return fail("validation_error", "entry_line_ids must be a non-empty array", 400, { requestId });
  }

  const { data, error } = await supabase
    .schema("finance")
    .rpc("reconcile_statement_line", {
      p_line_id: lineId,
      p_entry_line_ids: entryLineIds,
      p_organization_id: activeOrg.orgId,
    });

  if (error) return fail("db_error", error.message, 500, { requestId });

  return ok(data, { requestId });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; lineId: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "finance" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;
  const supabase = await createClient();

  const { lineId } = await params;

  const { data, error } = await supabase
    .schema("finance")
    .rpc("unreconcile_statement_line", {
      p_line_id: lineId,
      p_organization_id: activeOrg.orgId,
    });

  if (error) return fail("db_error", error.message, 500, { requestId });

  return ok(data, { requestId });
}
