import { randomUUID } from "node:crypto";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const viewMap: Record<string, string> = {
  ventas: "finance_v_libro_ventas_iva",
  compras: "finance_v_libro_compras_iva",
  iva: "finance_v_declaracion_iva_mensual",
  it: "finance_v_declaracion_it_mensual",
};

export async function GET(req: Request): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "finance" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const { searchParams } = new URL(req.url);
  const type = searchParams.get("type");
  if (!type || !viewMap[type]) {
    return fail("validation_error", `type must be one of: ${Object.keys(viewMap).join(", ")}`, 400, { requestId });
  }

  const year = searchParams.get("year");
  const month = searchParams.get("month");

  const supabase = await createClient();
  let query = supabase
    .from(viewMap[type]!)
    .select("*")
    .eq("organization_id", activeOrg.orgId);

  if (year) query = query.eq("year", Number(year));
  if (month) query = query.eq("month", Number(month));

  const { data, error } = await query;
  if (error) return fail("internal_error", "Failed to fetch fiscal book", 500, { requestId });
  return ok(data, { requestId });
}
