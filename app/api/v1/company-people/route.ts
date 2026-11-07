import { type NextRequest } from "next/server";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { fail } from "@/lib/api/wrappers";
import { autorDe, ctxDeToken, existeNaOrganizacao } from "@/lib/api/token-operacao";
import { extractBearer } from "@/lib/mcp/auth";
import { companyPersonCreateSchema } from "@/lib/crm-b2b/schemas";

import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { linkCompanyPersonHandler } from "@/lib/crm-b2b/people-handler";
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
 * Com Bearer: `mcp:write` e papel `manager`, o da sessão. Empresa e pessoa do corpo
 * têm de ser desta organização: a chave estrangeira não confere isso, e o vínculo
 * seria gravado com o id de outra organização.
 */
async function vincularPeloToken(req: NextRequest, requestId: string): Promise<Response> {
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "company_people",
    role: "manager",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "company_people_link", requestId);
  if (teto) return teto;

  try {
    const body = await req.json();
    const vinculo = companyPersonCreateSchema.safeParse(body);
    if (vinculo.success) {
      const { company_id, person_id } = vinculo.data;
      if (!(await existeNaOrganizacao(authz.supabase, "companies", authz.organizationId, company_id))) {
        return fail("not_found", "Empresa não encontrada.", 404, { requestId });
      }
      if (!(await existeNaOrganizacao(authz.supabase, "people", authz.organizationId, person_id))) {
        return fail("not_found", "Pessoa não encontrada.", 404, { requestId });
      }
    }
    const data = await linkCompanyPersonHandler(
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

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = requestIdOf(req);
  const desligado = await seModuloB2bDesligado(requestId);
  if (desligado) return desligado;
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  if (extractBearer(req.headers.get("authorization"))) return vincularPeloToken(req, requestId);
  const authz = await requireRole("manager", { requestId, resource: "company_people" });
  if (!authz.ok) return authz.response;

  try {
    const body = await req.json();
    const supabase = await createClient();
    const data = await linkCompanyPersonHandler(
      supabase,
      ctxFromAuthz(authz, requestId),
      authz.user.id,
      body,
    );
    return ok(data, { requestId, status: 201 });
  } catch (e) {
    return handleRouteError(e, requestId);
  }
}
