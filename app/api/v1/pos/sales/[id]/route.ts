import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/* GET /api/v1/pos/sales/:id — single sale with lines and payments */
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

  const { data: sale, error } = await supabase
    .from("finance_sales")
    .select("*")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .single();

  if (error || !sale) return fail("not_found", "Sale not found", 404, { requestId });

  const [{ data: lines }, { data: payments }] = await Promise.all([
    supabase
      .from("finance_sale_lines")
      .select("*")
      .eq("sale_id", id)
      .eq("organization_id", activeOrg.orgId),
    supabase
      .from("finance_sale_payments")
      .select("*, finance_payment_methods(name, type)")
      .eq("sale_id", id)
      .eq("organization_id", activeOrg.orgId),
  ]);

  return ok({ ...sale, lines: lines ?? [], payments: payments ?? [] }, { requestId });
}
