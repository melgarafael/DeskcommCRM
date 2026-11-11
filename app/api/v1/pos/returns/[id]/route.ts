import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/* GET /api/v1/pos/returns/:id — get return with lines */
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

  const { data: ret, error: retErr } = await supabase
    .from("finance_pos_returns")
    .select("*")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .single();

  if (retErr || !ret) return fail("not_found", "Return not found", 404, { requestId });

  const { data: lines } = await supabase
    .from("finance_pos_return_lines")
    .select("*")
    .eq("return_id", id)
    .order("created_at", { ascending: true });

  return ok({ ...ret, lines: lines ?? [] }, { requestId });
}
