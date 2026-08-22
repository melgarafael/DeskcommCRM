/**
 * Fábrica de rotas para accounting_payables/accounting_receivables — as duas
 * tabelas têm o MESMO contrato (descrição, valor, vencimento, baixa), e
 * duplicar o handler duas vezes divergiria na primeira correção que só
 * lembrasse de uma tabela. `table` é literal, nunca vindo de request — é
 * escolhido pelo arquivo de rota que importa a fábrica, não por input externo.
 */
import { type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import type { AuditAction } from "@/lib/audit/actions";
import { createAdminClient } from "@/lib/supabase/admin";

type LedgerTable = "accounting_payables" | "accounting_receivables";

const createSchema = z.object({
  client_company_id: z.string().uuid(),
  description: z.string().min(2).max(500),
  amount_cents: z.number().int().positive(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "due_date deve ser YYYY-MM-DD"),
});

interface LedgerConfig {
  table: LedgerTable;
  createdAction: AuditAction;
  paidAction: AuditAction;
}

export function buildLedgerRoutes(config: LedgerConfig) {
  async function GET(req: NextRequest) {
    const requestId = randomUUID();
    const authz = await requireRole("viewer", { requestId, resource: "accounting" });
    if (!authz.ok) return authz.response;

    const clientCompanyId = req.nextUrl.searchParams.get("client_company_id");
    if (!clientCompanyId) {
      return fail("validation_failed", "client_company_id é obrigatório", 400, { requestId });
    }

    const admin = createAdminClient();
    const { data, error } = await admin
      .from(config.table)
      .select("id, description, amount_cents, due_date, paid_at, status")
      .eq("organization_id", authz.org.orgId)
      .eq("client_company_id", clientCompanyId)
      .order("due_date", { ascending: true });

    if (error) return fail("internal_error", `Failed to load ${config.table}`, 500, { requestId });
    return ok(data ?? [], { requestId });
  }

  async function POST(req: NextRequest) {
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
    const { data: company } = await admin
      .from("accounting_client_companies")
      .select("id")
      .eq("organization_id", authz.org.orgId)
      .eq("id", parsed.data.client_company_id)
      .maybeSingle();
    if (!company) return fail("not_found", "Client company not found", 404, { requestId });

    const { data, error } = await admin
      .from(config.table)
      .insert({
        organization_id: authz.org.orgId,
        client_company_id: parsed.data.client_company_id,
        description: parsed.data.description,
        amount_cents: parsed.data.amount_cents,
        due_date: parsed.data.due_date,
      })
      .select("id, description, amount_cents, due_date, paid_at, status")
      .single();

    if (error) return fail("internal_error", `Failed to create ${config.table}`, 500, { requestId });

    void audit({
      action: config.createdAction,
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: config.table,
      resourceId: data.id,
      requestId,
      metadata: { client_company_id: parsed.data.client_company_id },
    });

    return ok(data, { status: 201, requestId });
  }

  async function markPaid(req: NextRequest, id: string) {
    const requestId = randomUUID();
    const authz = await requireRole("manager", { requestId, resource: "accounting" });
    if (!authz.ok) return authz.response;

    const admin = createAdminClient();
    const { data, error } = await admin
      .from(config.table)
      .update({ status: "paid", paid_at: new Date().toISOString() })
      .eq("organization_id", authz.org.orgId)
      .eq("id", id)
      .select("id, description, amount_cents, due_date, paid_at, status")
      .maybeSingle();

    if (error) return fail("internal_error", `Failed to update ${config.table}`, 500, { requestId });
    if (!data) return fail("not_found", "Registro não encontrado", 404, { requestId });

    void audit({
      action: config.paidAction,
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: config.table,
      resourceId: data.id,
      requestId,
    });

    return ok(data, { requestId });
  }

  return { GET, POST, markPaid };
}
