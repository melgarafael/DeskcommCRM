import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "pos" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const body = await req.json().catch(() => null);
  if (!body?.code) {
    return fail("validation", "code is required", 422, { requestId });
  }

  const supabase = await createClient();
  const { data: discount, error } = await supabase
    .from("finance_discounts")
    .select("*")
    .eq("organization_id", activeOrg.orgId)
    .eq("promo_code", body.code.toUpperCase().trim())
    .eq("is_active", true)
    .single();

  if (error || !discount) {
    return fail("not_found", "Código promocional no encontrado", 404, { requestId });
  }

  const today = new Date().toISOString().split("T")[0]!;
  if (discount.valid_from && today < discount.valid_from) {
    return fail("validation", "Este descuento aún no está vigente", 422, { requestId });
  }
  if (discount.valid_until && today > discount.valid_until) {
    return fail("validation", "Este descuento ya expiró", 422, { requestId });
  }
  if (discount.max_uses && discount.current_uses >= discount.max_uses) {
    return fail("validation", "Este código ya alcanzó su límite de usos", 422, { requestId });
  }

  return ok(discount, { requestId });
}
