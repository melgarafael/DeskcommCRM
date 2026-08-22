/**
 * GET /api/v1/accounting/cash-flow?client_company_id=&period_start=&period_end=
 *
 * Chama fn_cash_flow_summary (migration 0171) — soma de baixas pagas no
 * período, calculada on-demand (doutrina DIRC "Calcular"), nunca uma tabela
 * derivada que dessincroniza no primeiro UPDATE de status esquecido.
 */
import { type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import { ok, fail } from "@/lib/api/wrappers";
import { createAdminClient } from "@/lib/supabase/admin";

const querySchema = z.object({
  client_company_id: z.string().uuid(),
  period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  period_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export async function GET(req: NextRequest) {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "accounting" });
  if (!authz.ok) return authz.response;

  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams.entries()));
  if (!parsed.success) {
    return fail("validation_failed", "Invalid query params", 400, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const admin = createAdminClient();

  // A função roda com o papel do chamador (não é security definer) — mas
  // como esta rota usa o client de service_role, filtra a organização
  // manualmente ANTES de confiar no client_company_id (doutrina: fonte
  // confiável, nunca o parâmetro solto).
  const { data: company } = await admin
    .from("accounting_client_companies")
    .select("id")
    .eq("organization_id", authz.org.orgId)
    .eq("id", parsed.data.client_company_id)
    .maybeSingle();
  if (!company) return fail("not_found", "Client company not found", 404, { requestId });

  const { data, error } = await admin.rpc("fn_cash_flow_summary", {
    p_client_company_id: parsed.data.client_company_id,
    p_period_start: parsed.data.period_start,
    p_period_end: parsed.data.period_end,
  });

  if (error) return fail("internal_error", "Failed to compute cash flow", 500, { requestId });
  return ok(data?.[0] ?? { total_received_cents: 0, total_paid_cents: 0, net_cents: 0 }, {
    requestId,
  });
}
