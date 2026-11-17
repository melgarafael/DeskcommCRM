import { type NextRequest } from "next/server";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import {
  fail,
  handleRouteError,
  ok,
  requestIdOf,
  seModuloB2bDesligado,
} from "@/lib/crm-b2b/route-helpers";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/v1/imports/[id] — um lote da org e as linhas dele.
 *
 * Sessão OU token de servidor `dsk_…` (`mcp:read`, piso viewer). O lote e as
 * linhas são filtrados pela organização da sessão ou da LINHA do token, nunca
 * pelo id do path sozinho.
 */
export async function GET(req: NextRequest, { params }: Ctx): Promise<Response> {
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
  const { id } = await params;

  try {
    const supabase = authz.supabase;
    const { data: batch, error } = await supabase
      .from("import_batches")
      .select("*")
      .eq("organization_id", authz.organizationId)
      .eq("id", id)
      .maybeSingle();
    if (error) return fail("internal_error", error.message, 500, { requestId });
    if (!batch) return fail("not_found", "Importação não encontrada.", 404, { requestId });

    const statusFilter = req.nextUrl.searchParams.get("status");
    let rowsQ = supabase
      .from("import_rows")
      .select(
        "id, row_number, status, error, company_id, person_id, contact_id, raw_data, normalized_data, created_at",
      )
      .eq("organization_id", authz.organizationId)
      .eq("batch_id", id)
      .order("row_number", { ascending: true })
      .limit(500);

    if (statusFilter) rowsQ = rowsQ.eq("status", statusFilter);

    const { data: rows } = await rowsQ;
    return ok({ batch, rows: rows ?? [] }, { requestId });
  } catch (e) {
    return handleRouteError(e, requestId);
  }
}
