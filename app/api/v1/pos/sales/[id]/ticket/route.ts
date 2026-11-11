import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/* GET /api/v1/pos/sales/:id/ticket — get sale data + template for ticket generation */
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

  const { data: sale, error: saleErr } = await supabase
    .from("finance_sales")
    .select("*")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .single();

  if (saleErr || !sale)
    return fail("not_found", "Sale not found", 404, { requestId });

  const { data: lines } = await supabase
    .from("finance_sale_lines")
    .select("*")
    .eq("sale_id", id)
    .order("created_at", { ascending: true });

  const { data: payments } = await supabase
    .from("finance_payments")
    .select("*")
    .eq("sale_id", id)
    .order("created_at", { ascending: true });

  const { data: templates } = await supabase
    .from("finance_pos_ticket_templates")
    .select("*")
    .eq("organization_id", activeOrg.orgId)
    .eq("is_default", true)
    .limit(1);

  const template = templates?.[0] ?? null;

  return ok(
    {
      sale,
      lines: lines ?? [],
      payments: payments ?? [],
      template,
    },
    { requestId },
  );
}
