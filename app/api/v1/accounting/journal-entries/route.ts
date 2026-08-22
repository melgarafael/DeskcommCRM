/**
 * GET/POST /api/v1/accounting/journal-entries?client_company_id=<uuid>
 *
 * O invariante de partida dobrada (sum(debit)=sum(credit) por lançamento) é
 * de PRODUTO, não de schema (ver migration 0170) — esta rota é quem aplica a
 * política real: recusa 422 se o lançamento não fechar. O CHECK do banco só
 * garante débito XOR crédito por LINHA; sem a checagem aqui, um lançamento
 * desbalanceado entraria como `draft` válido para o schema e inválido para
 * qualquer relatório que dependa dele fechar.
 */
import { type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";

const lineSchema = z
  .object({
    account_id: z.string().uuid(),
    debit_cents: z.number().int().min(0).default(0),
    credit_cents: z.number().int().min(0).default(0),
  })
  .refine((l) => (l.debit_cents === 0) !== (l.credit_cents === 0), {
    message: "cada linha precisa ter OU débito OU crédito, nunca os dois nem nenhum",
  });

const createSchema = z.object({
  client_company_id: z.string().uuid(),
  entry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "entry_date deve ser YYYY-MM-DD"),
  description: z.string().min(2).max(500),
  lines: z.array(lineSchema).min(2, "um lançamento precisa de ao menos 2 linhas"),
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
    .from("accounting_journal_entries")
    .select("id, entry_date, description, status, posted_at, created_at")
    .eq("organization_id", authz.org.orgId)
    .eq("client_company_id", clientCompanyId)
    .order("entry_date", { ascending: false });

  if (error) return fail("internal_error", "Failed to load journal entries", 500, { requestId });
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

  const totalDebit = parsed.data.lines.reduce((sum, l) => sum + l.debit_cents, 0);
  const totalCredit = parsed.data.lines.reduce((sum, l) => sum + l.credit_cents, 0);
  if (totalDebit !== totalCredit) {
    return fail(
      "unprocessable_entity",
      `Lançamento não fecha: débito ${totalDebit} ≠ crédito ${totalCredit}`,
      422,
      { requestId },
    );
  }

  const admin = createAdminClient();

  const { data: company } = await admin
    .from("accounting_client_companies")
    .select("id")
    .eq("organization_id", authz.org.orgId)
    .eq("id", parsed.data.client_company_id)
    .maybeSingle();
  if (!company) {
    return fail("not_found", "Client company not found", 404, { requestId });
  }

  const { data: entry, error: entryError } = await admin
    .from("accounting_journal_entries")
    .insert({
      organization_id: authz.org.orgId,
      client_company_id: parsed.data.client_company_id,
      entry_date: parsed.data.entry_date,
      description: parsed.data.description,
      created_by_user_id: authz.user.id,
    })
    .select("id, entry_date, description, status")
    .single();

  if (entryError || !entry) {
    return fail("internal_error", "Failed to create journal entry", 500, { requestId });
  }

  const { error: linesError } = await admin.from("accounting_journal_entry_lines").insert(
    parsed.data.lines.map((l) => ({
      journal_entry_id: entry.id,
      account_id: l.account_id,
      debit_cents: l.debit_cents,
      credit_cents: l.credit_cents,
    })),
  );

  if (linesError) {
    // Sem transação cross-table no supabase-js: compensa apagando o cabeçalho
    // órfão em vez de deixar um lançamento sem nenhuma linha (pior que não
    // criar nada — apareceria em relatórios como lançamento zerado).
    await admin.from("accounting_journal_entries").delete().eq("id", entry.id);
    return fail("internal_error", "Failed to create journal entry lines", 500, { requestId });
  }

  void audit({
    action: "accounting.journal_entry_created",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "accounting_journal_entry",
    resourceId: entry.id,
    requestId,
    metadata: {
      client_company_id: parsed.data.client_company_id,
      total_cents: totalDebit,
      line_count: parsed.data.lines.length,
    },
  });

  void admin.from("accounting_client_company_activities").insert({
    organization_id: authz.org.orgId,
    client_company_id: parsed.data.client_company_id,
    source_module: "accounting",
    source_id: entry.id,
    type: "journal_entry_created",
    payload: { description: entry.description, total_cents: totalDebit },
    performed_by_user_id: authz.user.id,
  });

  return ok(entry, { status: 201, requestId });
}
