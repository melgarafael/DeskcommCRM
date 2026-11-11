import { type NextRequest } from "next/server";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { autorDe, ctxDeToken } from "@/lib/api/token-operacao";
import { extractBearer } from "@/lib/mcp/auth";

import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import {
  createCompanyHandler,
  listCompaniesHandler,
} from "@/lib/crm-b2b/companies-handler";
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
 * Com Bearer (integração): `mcp:read` e papel `viewer`, o da sessão. O teto de
 * escrita por token e por organização conta cada leitura desta rota.
 */
async function listarPeloToken(req: NextRequest, requestId: string): Promise<Response> {
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "companies",
    role: "viewer",
    scope: "mcp:read",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "companies_list", requestId);
  if (teto) return teto;

  try {
    const search = req.nextUrl.searchParams.get("search") ?? undefined;
    const limit = Number(req.nextUrl.searchParams.get("limit") ?? "50");
    const result = await listCompaniesHandler(authz.supabase, ctxDeToken(authz, requestId), {
      search,
      limit,
    });
    return ok(result.companies, { requestId, meta: { has_more: result.has_more } });
  } catch (e) {
    return handleRouteError(e, requestId);
  }
}

/** Com Bearer: `mcp:write` e papel `manager`, o da sessão. */
async function criarPeloToken(req: NextRequest, requestId: string): Promise<Response> {
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "companies",
    role: "manager",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "companies_create", requestId);
  if (teto) return teto;

  try {
    const body = await req.json();
    const data = await createCompanyHandler(
      authz.supabase,
      ctxDeToken(authz, requestId),
      autorDe(authz),
      body,
    );
    return ok(data, { requestId, status: 201 });
  } catch (e) {
    return handleRouteError(e, requestId);
  }
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = requestIdOf(req);
  const desligado = await seModuloB2bDesligado(requestId);
  if (desligado) return desligado;
  if (extractBearer(req.headers.get("authorization"))) return listarPeloToken(req, requestId);
  const authz = await requireRole("viewer", { requestId, resource: "companies" });
  if (!authz.ok) return authz.response;

  try {
    const supabase = await createClient();
    const search = req.nextUrl.searchParams.get("search") ?? undefined;
    const limit = Number(req.nextUrl.searchParams.get("limit") ?? "50");
    const ctx = ctxFromAuthz(authz, requestId);
    const result = await listCompaniesHandler(supabase, ctx, { search, limit });
    return ok(result.companies, { requestId, meta: { has_more: result.has_more } });
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
  if (extractBearer(req.headers.get("authorization"))) return criarPeloToken(req, requestId);
  const authz = await requireRole("manager", { requestId, resource: "companies" });
  if (!authz.ok) return authz.response;

  try {
    const body = await req.json();
    const supabase = await createClient();
    const ctx = ctxFromAuthz(authz, requestId);
    const data = await createCompanyHandler(supabase, ctx, authz.user.id, body);
    return ok(data, { requestId, status: 201 });
  } catch (e) {
    return handleRouteError(e, requestId);
  }
}
