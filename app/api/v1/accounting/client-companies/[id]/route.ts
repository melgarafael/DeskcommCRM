/**
 * GET /api/v1/accounting/client-companies/[id] — detalhe + timeline.
 * Leitura viewer+, mesma régua do resto do módulo.
 */
import { randomUUID } from "node:crypto";

import { requireRole } from "@/lib/auth/require-role";
import { ok, fail } from "@/lib/api/wrappers";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "accounting" });
  if (!authz.ok) return authz.response;
  const { id } = await params;

  const admin = createAdminClient();
  const { data: company, error } = await admin
    .from("accounting_client_companies")
    .select("id, legal_name, trade_name, cnpj, tax_regime, status, created_at")
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .maybeSingle();

  if (error) return fail("internal_error", "Failed to load client company", 500, { requestId });
  if (!company) return fail("not_found", "Client company not found", 404, { requestId });

  const { data: activities } = await admin
    .from("accounting_client_company_activities")
    .select("id, type, payload, performed_at")
    .eq("client_company_id", id)
    .order("performed_at", { ascending: false })
    .limit(20);

  return ok({ ...company, activities: activities ?? [] }, { requestId });
}
