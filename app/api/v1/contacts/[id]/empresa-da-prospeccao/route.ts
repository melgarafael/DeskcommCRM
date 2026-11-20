import { type NextRequest } from "next/server";

import {
  estadoDaEmpresaDaProspeccaoHandler,
  transformarContatoEmEmpresaHandler,
} from "@/lib/crm-b2b/empresa-da-prospeccao";
import {
  ctxFromAuthz,
  handleRouteError,
  ok,
  requestIdOf,
  seModuloB2bDesligado,
} from "@/lib/crm-b2b/route-helpers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/v1/contacts/:id/empresa-da-prospeccao — a ficha pergunta se o botão
 * "Transformar em empresa" faz sentido e qual Empresa já está ligada (#3198,
 * fatia 3). Módulo desligado: 404, como as demais rotas do módulo.
 */
export async function GET(req: NextRequest, { params }: Ctx): Promise<Response> {
  const requestId = requestIdOf(req);
  const desligado = await seModuloB2bDesligado(requestId);
  if (desligado) return desligado;
  const authz = await requireRole("viewer", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;
  const { id } = await params;

  try {
    const supabase = await createClient();
    const data = await estadoDaEmpresaDaProspeccaoHandler(supabase, ctxFromAuthz(authz, requestId), id);
    return ok(data, { requestId });
  } catch (e) {
    return handleRouteError(e, requestId);
  }
}

/**
 * POST /api/v1/contacts/:id/empresa-da-prospeccao — cria (ou reaproveita, pelo
 * `place_id`) a Empresa do contato que veio da prospecção e liga os dois.
 *
 * SÓ SESSÃO, de propósito: é o botão da ficha. Piso `agent`, o mesmo de criar
 * empresa e pessoa pela tela (migration 9370). O token de integração não tem
 * porta aqui — a Spec 33 abre a API por área, e esta rota não é de nenhuma.
 */
export async function POST(req: NextRequest, { params }: Ctx): Promise<Response> {
  const requestId = requestIdOf(req);
  const desligado = await seModuloB2bDesligado(requestId);
  if (desligado) return desligado;
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const authz = await requireRole("agent", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;
  const { id } = await params;

  try {
    const supabase = await createClient();
    const data = await transformarContatoEmEmpresaHandler(
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
