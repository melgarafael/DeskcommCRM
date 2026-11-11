import { type NextRequest } from "next/server";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { requireSupportWrite } from "@/lib/impersonate/support";
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
  seModuloB2bDesligado,
} from "@/lib/crm-b2b/route-helpers";
import { lerCorpoComTeto } from "@/lib/api/corpo-com-teto";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/imports — lista lotes da org.
 * POST /api/v1/imports — upload CSV/XLSX + processa companies/people/contacts.
 *
 * Sessão OU token de servidor `dsk_…` (Spec 33, R3): `mcp:read` no GET (piso
 * viewer) e `mcp:write` no POST (piso manager). A organização vem da sessão ou
 * da LINHA do token, nunca do corpo. Pelo token não há pessoa: as colunas de
 * autor (`created_by`, `created_by_user_id`) ficam nulas e o audit grava o id do
 * token em `actor_api_token_id`.
 *
 * O importador histórico de contatos (`/api/v1/contacts/import`) permanece.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const requestId = requestIdOf(req);
  const desligado = await seModuloB2bDesligado(requestId);
  if (desligado) return desligado;
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "imports",
    role: "viewer",
    scope: "mcp:read",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "imports", requestId);
  if (teto) return teto;

  try {
    const supabase = authz.supabase;
    const { data, error } = await supabase
      .from("import_batches")
      .select(
        "id, filename, status, kind, total_rows, processed_rows, successful_rows, failed_rows, conflict_rows, created_by, created_at, completed_at",
      )
      .eq("organization_id", authz.organizationId)
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
  const desligado = await seModuloB2bDesligado(requestId);
  if (desligado) return desligado;
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "imports",
    role: "manager",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "imports", requestId);
  if (teto) return teto;
  // Só pessoa vira autor: o id de um token não existe em `auth.users`.
  const autorId = authz.actor.type === "user" ? authz.actor.id : null;

  // 64 KB de folga para o envelope multipart e o campo `mapping`.
  const corpo = await lerCorpoComTeto(req, IMPORT_MAX_BYTES + 64 * 1024, {
    requestId,
    idioma: authz.idioma,
    acimaDoTeto: "Arquivo grande demais.",
  });
  if (!corpo.ok) return corpo.response;

  try {
    const form = await corpo.corpo.formData();
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

    const supabase = authz.supabase;
    const { data: batch, error: batchErr } = await supabase
      .from("import_batches")
      .insert({
        organization_id: authz.organizationId,
        kind: "companies_people",
        filename: nome,
        status: "pending",
        total_rows: parsed.sheet.rows.length,
        column_mapping: mapping,
        created_by: autorId,
      })
      .select("id")
      .single();

    if (batchErr || !batch) {
      return fail("internal_error", batchErr?.message ?? "Falha ao criar lote.", 500, {
        requestId,
      });
    }

    const summary = await processCompaniesPeopleImport(supabase, {
      organizationId: authz.organizationId,
      batchId: batch.id,
      userId: autorId,
      sheet: parsed.sheet,
      mapping,
      enrichCompanies: form.get("enrich") !== "false",
    });

    await audit({
      organizationId: authz.organizationId,
      actorUserId: autorId,
      actorApiTokenId: authz.apiTokenId ?? null,
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
