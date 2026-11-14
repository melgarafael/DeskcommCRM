import { type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import {
  corpoDoContatoDaEmpresa,
  createCompanyContactHandler,
  type ContatoDaEmpresaInput,
} from "@/lib/crm-b2b/company-contact-handler";
import {
  ctxFromAuthz,
  handleRouteError,
  ok,
  requestIdOf,
  seModuloB2bDesligado,
} from "@/lib/crm-b2b/route-helpers";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { perfilDaOrganizacao } from "@/lib/legal/perfil-do-pais";
import { contactCreateSchemaDoPais } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/v1/companies/:id/contatos — cadastra pessoa + contato e liga tudo
 * à empresa numa chamada só. Piso `agent`: quem atende cadastra o cliente novo
 * sem passar por três telas (a RLS de insert foi alinhada na migration 9348).
 */
export async function POST(req: NextRequest, { params }: Ctx): Promise<Response> {
  const requestId = requestIdOf(req);
  const desligado = await seModuloB2bDesligado(requestId);
  if (desligado) return desligado;
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const authz = await requireRole("agent", { requestId, resource: "companies" });
  if (!authz.ok) return authz.response;
  const { id } = await params;

  try {
    const supabase = await createClient();
    // O telefone segue a régua do PAÍS da organização, nunca o corpo da requisição.
    const perfil = await perfilDaOrganizacao(supabase, authz.org.orgId);
    const telefone = contactCreateSchemaDoPais(perfil).shape.phone_number;
    const body = corpoDoContatoDaEmpresa(telefone).parse(await req.json()) as ContatoDaEmpresaInput;
    const data = await createCompanyContactHandler(
      supabase,
      ctxFromAuthz(authz, requestId),
      authz.user.id,
      id,
      body,
    );
    return ok(data, { requestId, status: 201 });
  } catch (e) {
    return handleRouteError(e, requestId);
  }
}
