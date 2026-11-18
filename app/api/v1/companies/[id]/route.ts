import { type NextRequest } from "next/server";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { autorDe, ctxDeToken } from "@/lib/api/token-operacao";
import { extractBearer } from "@/lib/mcp/auth";

import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import {
  deleteCompanyHandler,
  getCompanyHandler,
  patchCompanyHandler,
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

type Ctx = { params: Promise<{ id: string }> };

/** Com Bearer: `mcp:read` e papel `viewer`. A empresa é lida só da organização do token. */
async function lerPeloToken(
  req: NextRequest,
  requestId: string,
  params: Ctx["params"],
): Promise<Response> {
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "companies",
    role: "viewer",
    scope: "mcp:read",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "companies_read", requestId);
  if (teto) return teto;
  const { id } = await params;

  try {
    const data = await getCompanyHandler(authz.supabase, ctxDeToken(authz, requestId), id);
    return ok(data, { requestId });
  } catch (e) {
    return handleRouteError(e, requestId);
  }
}

/** Com Bearer: `mcp:write` e papel `agent`, o da sessão. */
async function atualizarPeloToken(
  req: NextRequest,
  requestId: string,
  params: Ctx["params"],
): Promise<Response> {
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "companies",
    role: "agent",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "companies_update", requestId);
  if (teto) return teto;
  const { id } = await params;

  try {
    const body = await req.json();
    const data = await patchCompanyHandler(
      authz.supabase,
      ctxDeToken(authz, requestId),
      autorDe(authz),
      id,
      body,
    );
    return ok(data, { requestId });
  } catch (e) {
    return handleRouteError(e, requestId);
  }
}

/** Com Bearer: `mcp:write` e papel `manager`, o da sessão. Remove só a empresa; os vínculos com pessoas travam a exclusão. */
async function excluirPeloToken(
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
  const teto = await tetoDeEscritaDoToken(authz, "companies_delete", requestId);
  if (teto) return teto;
  const { id } = await params;

  try {
    const data = await deleteCompanyHandler(
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

export async function GET(req: NextRequest, { params }: Ctx): Promise<Response> {
  const requestId = requestIdOf(req);
  const desligado = await seModuloB2bDesligado(requestId);
  if (desligado) return desligado;
  if (extractBearer(req.headers.get("authorization"))) return lerPeloToken(req, requestId, params);
  const authz = await requireRole("viewer", { requestId, resource: "companies" });
  if (!authz.ok) return authz.response;
  const { id } = await params;

  try {
    const supabase = await createClient();
    const data = await getCompanyHandler(supabase, ctxFromAuthz(authz, requestId), id);
    return ok(data, { requestId });
  } catch (e) {
    return handleRouteError(e, requestId);
  }
}

export async function PATCH(req: NextRequest, { params }: Ctx): Promise<Response> {
  const requestId = requestIdOf(req);
  const desligado = await seModuloB2bDesligado(requestId);
  if (desligado) return desligado;
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  if (extractBearer(req.headers.get("authorization")))
    return atualizarPeloToken(req, requestId, params);
  const authz = await requireRole("agent", { requestId, resource: "companies" });
  if (!authz.ok) return authz.response;
  const { id } = await params;

  try {
    const body = await req.json();
    const supabase = await createClient();
    const data = await patchCompanyHandler(
      supabase,
      ctxFromAuthz(authz, requestId),
      authz.user.id,
      id,
      body,
    );
    return ok(data, { requestId });
  } catch (e) {
    return handleRouteError(e, requestId);
  }
}

/** DELETE /api/v1/companies/:id — exclusão segura (manager+). */
export async function DELETE(req: NextRequest, { params }: Ctx): Promise<Response> {
  const requestId = requestIdOf(req);
  const desligado = await seModuloB2bDesligado(requestId);
  if (desligado) return desligado;
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  if (extractBearer(req.headers.get("authorization")))
    return excluirPeloToken(req, requestId, params);
  const authz = await requireRole("manager", { requestId, resource: "companies" });
  if (!authz.ok) return authz.response;
  const { id } = await params;

  try {
    const supabase = await createClient();
    const data = await deleteCompanyHandler(
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
