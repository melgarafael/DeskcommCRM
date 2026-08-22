/**
 * GET/POST /api/v1/accounting/client-companies — empresas atendidas pelo
 * escritório contábil (tenant). Leitura viewer+, escrita manager+ (mesma
 * régua da RLS — a rota é o primeiro gate, a policy é o segundo, nunca o
 * único: PostgREST é alcançável direto pelo browser com o JWT do usuário).
 */
import { type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";

const createSchema = z.object({
  legal_name: z.string().min(2).max(255),
  trade_name: z.string().max(255).optional(),
  cnpj: z.string().min(11).max(18),
  tax_regime: z.string().max(60).optional(),
});

export async function GET() {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "accounting" });
  if (!authz.ok) return authz.response;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("accounting_client_companies")
    .select("id, legal_name, trade_name, cnpj, tax_regime, status, created_at")
    .eq("organization_id", authz.org.orgId)
    .order("legal_name", { ascending: true });

  if (error) return fail("internal_error", "Failed to load client companies", 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest) {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "accounting" });
  if (!authz.ok) return authz.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("invalid_request", "Invalid JSON body", 400, { requestId });
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return fail("validation_failed", "Invalid request body", 400, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("accounting_client_companies")
    .insert({
      organization_id: authz.org.orgId,
      legal_name: parsed.data.legal_name,
      trade_name: parsed.data.trade_name ?? null,
      cnpj: parsed.data.cnpj,
      tax_regime: parsed.data.tax_regime ?? null,
      created_by_user_id: authz.user.id,
    })
    .select("id, legal_name, trade_name, cnpj, tax_regime, status, created_at")
    .single();

  if (error) {
    if (error.code === "23505") {
      return fail("conflict", "Já existe uma empresa com este CNPJ", 409, { requestId });
    }
    return fail("internal_error", "Failed to create client company", 500, { requestId });
  }

  void audit({
    action: "accounting.client_company_created",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "accounting_client_company",
    resourceId: data.id,
    requestId,
    metadata: { legal_name: data.legal_name },
  });

  void admin.from("accounting_client_company_activities").insert({
    organization_id: authz.org.orgId,
    client_company_id: data.id,
    source_module: "accounting",
    type: "client_company_created",
    payload: { legal_name: data.legal_name },
    performed_by_user_id: authz.user.id,
  });

  return ok(data, { status: 201, requestId });
}
