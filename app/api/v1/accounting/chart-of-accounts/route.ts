/**
 * GET/POST /api/v1/accounting/chart-of-accounts?client_company_id=<uuid>
 * Plano de contas de UMA empresa-cliente. client_company_id vem de query
 * string, mas a organização é SEMPRE de requireRole — a query filtra o
 * client_company_id contra a organização ativa, então um id de outro tenant
 * simplesmente não bate (RLS reforça o mesmo, na segunda camada).
 */
import { type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";

const ACCOUNT_TYPES = ["asset", "liability", "equity", "revenue", "expense"] as const;

const createSchema = z.object({
  client_company_id: z.string().uuid(),
  code: z.string().min(1).max(20),
  name: z.string().min(2).max(120),
  account_type: z.enum(ACCOUNT_TYPES),
  parent_id: z.string().uuid().optional(),
});

export async function GET(req: NextRequest) {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "accounting" });
  if (!authz.ok) return authz.response;

  const clientCompanyId = req.nextUrl.searchParams.get("client_company_id");
  if (!clientCompanyId) {
    return fail("validation_failed", "client_company_id é obrigatório", 400, { requestId });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("accounting_chart_of_accounts")
    .select("id, code, name, account_type, parent_id, is_active")
    .eq("organization_id", authz.org.orgId)
    .eq("client_company_id", clientCompanyId)
    .order("code", { ascending: true });

  if (error) return fail("internal_error", "Failed to load chart of accounts", 500, { requestId });
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

  // A empresa-cliente precisa pertencer à MESMA organização — nunca confiar
  // no client_company_id do body sozinho (poderia ser de outro tenant; RLS
  // barraria no INSERT, mas o erro genérico não diria por quê).
  const { data: company } = await admin
    .from("accounting_client_companies")
    .select("id")
    .eq("organization_id", authz.org.orgId)
    .eq("id", parsed.data.client_company_id)
    .maybeSingle();
  if (!company) {
    return fail("not_found", "Client company not found", 404, { requestId });
  }

  const { data, error } = await admin
    .from("accounting_chart_of_accounts")
    .insert({
      organization_id: authz.org.orgId,
      client_company_id: parsed.data.client_company_id,
      code: parsed.data.code,
      name: parsed.data.name,
      account_type: parsed.data.account_type,
      parent_id: parsed.data.parent_id ?? null,
    })
    .select("id, code, name, account_type, parent_id, is_active")
    .single();

  if (error) {
    if (error.code === "23505") {
      return fail("conflict", "Já existe uma conta com este código nesta empresa", 409, {
        requestId,
      });
    }
    return fail("internal_error", "Failed to create account", 500, { requestId });
  }

  void audit({
    action: "accounting.chart_of_accounts_created",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "accounting_chart_of_accounts",
    resourceId: data.id,
    requestId,
    metadata: { client_company_id: parsed.data.client_company_id, code: data.code },
  });

  return ok(data, { status: 201, requestId });
}
