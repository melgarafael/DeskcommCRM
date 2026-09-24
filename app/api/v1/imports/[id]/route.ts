import { type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import {
  fail,
  handleRouteError,
  ok,
  requestIdOf,
} from "@/lib/crm-b2b/route-helpers";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Ctx): Promise<Response> {
  const requestId = requestIdOf(req);
  const authz = await requireRole("viewer", { requestId, resource: "imports" });
  if (!authz.ok) return authz.response;
  const { id } = await params;

  try {
    const supabase = await createClient();
    const { data: batch, error } = await supabase
      .from("import_batches")
      .select("*")
      .eq("organization_id", authz.org.orgId)
      .eq("id", id)
      .maybeSingle();
    if (error) return fail("internal_error", error.message, 500, { requestId });
    if (!batch) return fail("not_found", "Importação não encontrada.", 404, { requestId });

    const statusFilter = req.nextUrl.searchParams.get("status");
    let rowsQ = supabase
      .from("import_rows")
      .select(
        "id, row_number, status, error, company_id, person_id, contact_id, raw_data, normalized_data, created_at",
      )
      .eq("organization_id", authz.org.orgId)
      .eq("batch_id", id)
      .order("row_number", { ascending: true })
      .limit(500);

    if (statusFilter) rowsQ = rowsQ.eq("status", statusFilter);

    const { data: rows } = await rowsQ;
    return ok({ batch, rows: rows ?? [] }, { requestId });
  } catch (e) {
    return handleRouteError(e, requestId);
  }
}
