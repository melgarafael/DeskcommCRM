import { type NextRequest } from "next/server";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { autorDe, ctxDeToken } from "@/lib/api/token-operacao";
import { extractBearer } from "@/lib/mcp/auth";

import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { patchCompanyPersonHandler } from "@/lib/crm-b2b/people-handler";
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

/** Com Bearer: `mcp:write` e papel `agent`, o da sessão. */
async function atualizarPeloToken(
  req: NextRequest,
  requestId: string,
  params: Ctx["params"],
): Promise<Response> {
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "company_people",
    role: "agent",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "company_people_update", requestId);
  if (teto) return teto;
  const { id } = await params;

  try {
    const body = await req.json();
    const data = await patchCompanyPersonHandler(
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

export async function PATCH(req: NextRequest, { params }: Ctx): Promise<Response> {
  const requestId = requestIdOf(req);
  const desligado = await seModuloB2bDesligado(requestId);
  if (desligado) return desligado;
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  if (extractBearer(req.headers.get("authorization")))
    return atualizarPeloToken(req, requestId, params);
  const authz = await requireRole("agent", { requestId, resource: "company_people" });
  if (!authz.ok) return authz.response;
  const { id } = await params;

  try {
    const body = await req.json();
    const supabase = await createClient();
    const data = await patchCompanyPersonHandler(
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
