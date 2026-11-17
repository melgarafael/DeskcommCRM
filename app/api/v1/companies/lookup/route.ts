import { type NextRequest } from "next/server";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { ctxDeToken } from "@/lib/api/token-operacao";
import { extractBearer } from "@/lib/mcp/auth";

import { requireRole } from "@/lib/auth/require-role";
import { lookupCompanyCnpjHandler } from "@/lib/crm-b2b/companies-handler";
import {
  ctxFromAuthz,
  handleRouteError,
  ok,
  requestIdOf,
  seModuloB2bDesligado,
} from "@/lib/crm-b2b/route-helpers";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Com Bearer: `mcp:read` e papel `manager`, o da sessão. Cada consulta sai para a
 * BrasilAPI, por isso conta no teto de escrita por token e por organização.
 */
async function consultarPeloToken(req: NextRequest, requestId: string): Promise<Response> {
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "companies",
    role: "manager",
    scope: "mcp:read",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "companies_lookup", requestId);
  if (teto) return teto;

  try {
    const cnpj = req.nextUrl.searchParams.get("cnpj") ?? "";
    const data = await lookupCompanyCnpjHandler(
      authz.supabase,
      ctxDeToken(authz, requestId),
      { cnpj },
    );
    return ok(data, { requestId });
  } catch (e) {
    return handleRouteError(e, requestId);
  }
}

/**
 * GET /api/v1/companies/lookup?cnpj=...
 *
 * Consulta um CNPJ na BrasilAPI antes de criar — devolve os dados públicos
 * para a tela preencher e revisar. Não grava nada (leitura). Manager+, o
 * mesmo piso da criação e do reenriquecimento: cada clique sai para um
 * serviço de terceiro, e quem não pode criar não precisa consultar.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const requestId = requestIdOf(req);
  const desligado = await seModuloB2bDesligado(requestId);
  if (desligado) return desligado;
  if (extractBearer(req.headers.get("authorization"))) return consultarPeloToken(req, requestId);
  const authz = await requireRole("manager", { requestId, resource: "companies" });
  if (!authz.ok) return authz.response;

  try {
    const cnpj = req.nextUrl.searchParams.get("cnpj") ?? "";
    const supabase = await createClient();
    const data = await lookupCompanyCnpjHandler(supabase, ctxFromAuthz(authz, requestId), { cnpj });
    return ok(data, { requestId });
  } catch (e) {
    return handleRouteError(e, requestId);
  }
}
