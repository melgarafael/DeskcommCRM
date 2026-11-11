import { type NextRequest } from "next/server";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { fail } from "@/lib/api/wrappers";
import { autorDe, ctxDeToken, existeNaOrganizacao } from "@/lib/api/token-operacao";
import { extractBearer } from "@/lib/mcp/auth";

import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { enrichCompanyHandler } from "@/lib/crm-b2b/companies-handler";
import {
  ctxFromAuthz,
  handleRouteError,
  ok,
  requestIdOf,
  seModuloB2bDesligado,
} from "@/lib/crm-b2b/route-helpers";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Com Bearer: `mcp:write` e papel `manager`, o da sessão. A empresa tem de ser da
 * organização do token antes do enriquecimento: senão a rota devolveria 404 só
 * depois de já ter gravado o registro de auditoria.
 */
async function enriquecerPeloToken(
  req: NextRequest,
  requestId: string,
  params: Ctx["params"],
): Promise<Response> {
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "companies",
    role: "manager",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "companies_enrich", requestId);
  if (teto) return teto;
  const { id } = await params;
  if (!(await existeNaOrganizacao(authz.supabase, "companies", authz.organizationId, id))) {
    return fail("not_found", "Empresa não encontrada.", 404, { requestId });
  }

  try {
    const data = await enrichCompanyHandler(
      authz.supabase,
      ctxDeToken(authz, requestId),
      autorDe(authz),
      id,
    );
    return ok(data, { requestId });
  } catch (e) {
    return handleRouteError(e, requestId);
  }
}

/** POST /api/v1/companies/:id/enrich — reprocessa BrasilAPI (manager+). */
export async function POST(req: NextRequest, { params }: Ctx): Promise<Response> {
  const requestId = requestIdOf(req);
  const desligado = await seModuloB2bDesligado(requestId);
  if (desligado) return desligado;
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  if (extractBearer(req.headers.get("authorization")))
    return enriquecerPeloToken(req, requestId, params);
  const authz = await requireRole("manager", { requestId, resource: "companies" });
  if (!authz.ok) return authz.response;
  const { id } = await params;

  try {
    const supabase = await createClient();
    const data = await enrichCompanyHandler(
      supabase,
      ctxFromAuthz(authz, requestId),
      authz.user.id,
      id,
    );
    return ok(data, { requestId });
  } catch (e) {
    return handleRouteError(e, requestId);
  }
}
