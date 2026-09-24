import { type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { audit } from "@/lib/audit";
import { processCompaniesPeopleImport } from "@/lib/crm-b2b/import-process";
import { importColumnMappingSchema } from "@/lib/crm-b2b/schemas";
import {
  IMPORT_MAX_BYTES,
  isCsvFilename,
  isXlsxFilename,
  parseImportFile,
  suggestColumnMapping,
  type MappingField,
} from "@/lib/crm-b2b/spreadsheet";
import {
  fail,
  handleRouteError,
  ok,
  requestIdOf,
} from "@/lib/crm-b2b/route-helpers";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/imports — lista lotes da org.
 * POST /api/v1/imports — upload CSV/XLSX + processa companies/people/contacts.
 *
 * O importador histórico de contatos (`/api/v1/contacts/import`) permanece.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const requestId = requestIdOf(req);
  const authz = await requireRole("viewer", { requestId, resource: "imports" });
  if (!authz.ok) return authz.response;

  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("import_batches")
      .select(
        "id, filename, status, kind, total_rows, processed_rows, successful_rows, failed_rows, conflict_rows, created_by, created_at, completed_at",
      )
      .eq("organization_id", authz.org.orgId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) return fail("internal_error", error.message, 500, { requestId });
    return ok(data ?? [], { requestId });
  } catch (e) {
    return handleRouteError(e, requestId);
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = requestIdOf(req);
  const authz = await requireRole("manager", { requestId, resource: "imports" });
  if (!authz.ok) return authz.response;

  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return fail("validation_failed", "Envie o arquivo no campo 'file'.", 422, { requestId });
    }
    const nome = file.name ?? "import.csv";
    if (!isCsvFilename(nome) && !isXlsxFilename(nome)) {
      return fail(
        "validation_failed",
        "Formato não suportado — envie .csv ou .xlsx.",
        422,
        { requestId },
      );
    }
    if (file.size > IMPORT_MAX_BYTES) {
      return fail("validation_failed", "Arquivo grande demais.", 422, { requestId });
    }

    let mapping: Partial<Record<MappingField, string>> = {};
    const mappingRaw = form.get("mapping");
    if (typeof mappingRaw === "string" && mappingRaw.trim()) {
      mapping = importColumnMappingSchema.parse(JSON.parse(mappingRaw));
    }

    const bytes = await file.arrayBuffer();
    const parsed = await parseImportFile(bytes, nome);
    if (!parsed.ok) {
      return fail("validation_failed", parsed.error, 422, { requestId });
    }

    if (Object.keys(mapping).length === 0) {
      mapping = suggestColumnMapping(parsed.sheet.headers);
    }

    const supabase = await createClient();
    const { data: batch, error: batchErr } = await supabase
      .from("import_batches")
      .insert({
        organization_id: authz.org.orgId,
        kind: "companies_people",
        filename: nome,
        status: "pending",
        total_rows: parsed.sheet.rows.length,
        column_mapping: mapping,
        created_by: authz.user.id,
      })
      .select("id")
      .single();

    if (batchErr || !batch) {
      return fail("internal_error", batchErr?.message ?? "Falha ao criar lote.", 500, {
        requestId,
      });
    }

    const summary = await processCompaniesPeopleImport(supabase, {
      organizationId: authz.org.orgId,
      batchId: batch.id,
      userId: authz.user.id,
      sheet: parsed.sheet,
      mapping,
      enrichCompanies: form.get("enrich") !== "false",
    });

    await audit({
      organizationId: authz.org.orgId,
      actorUserId: authz.user.id,
      action: "imports.companies_people",
      resourceType: "import_batches",
      resourceId: batch.id,
      requestId,
      metadata: summary as unknown as Record<string, unknown>,
    });

    return ok(
      {
        batch_id: batch.id,
        suggested_mapping: suggestColumnMapping(parsed.sheet.headers),
        headers: parsed.sheet.headers,
        ...summary,
      },
      { requestId, status: 201 },
    );
  } catch (e) {
    return handleRouteError(e, requestId);
  }
}
