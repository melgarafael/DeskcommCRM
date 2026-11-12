import { type NextRequest } from "next/server";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { autorDe, ctxDeToken } from "@/lib/api/token-operacao";
import { extractBearer } from "@/lib/mcp/auth";

import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { getPersonHandler, patchPersonHandler } from "@/lib/crm-b2b/people-handler";
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

/** Com Bearer: `mcp:read` e papel `viewer`. A pessoa é lida só da organização do token. */
async function lerPeloToken(
  req: NextRequest,
  requestId: string,
  params: Ctx["params"],
): Promise<Response> {
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "people",
    role: "viewer",
    scope: "mcp:read",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "people_read", requestId);
  if (teto) return teto;
  const { id } = await params;

  try {
    const data = await getPersonHandler(authz.supabase, ctxDeToken(authz, requestId), id);
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
    resource: "people",
    role: "agent",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "people_update", requestId);
  if (teto) return teto;
  const { id } = await params;

  try {
    const body = await req.json();
    const data = await patchPersonHandler(
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

export async function GET(req: NextRequest, { params }: Ctx): Promise<Response> {
  const requestId = requestIdOf(req);
  const desligado = await seModuloB2bDesligado(requestId);
  if (desligado) return desligado;
  if (extractBearer(req.headers.get("authorization"))) return lerPeloToken(req, requestId, params);
  const authz = await requireRole("viewer", { requestId, resource: "people" });
  if (!authz.ok) return authz.response;
  const { id } = await params;

  try {
    const supabase = await createClient();
    const data = await getPersonHandler(supabase, ctxFromAuthz(authz, requestId), id);
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
  const authz = await requireRole("agent", { requestId, resource: "people" });
  if (!authz.ok) return authz.response;
  const { id } = await params;

  try {
    const body = await req.json();
    const supabase = await createClient();
    const data = await patchPersonHandler(
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
