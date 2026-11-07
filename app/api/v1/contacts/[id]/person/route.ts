import { type NextRequest } from "next/server";
import { z } from "zod";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { linkContactToPersonHandler } from "@/lib/crm-b2b/people-handler";
import {
  handleRouteError,
  ok,
  requestIdOf,
  seModuloB2bDesligado,
} from "@/lib/crm-b2b/route-helpers";
import type { HandlerCtx } from "@/lib/api/handlers/types";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  person_id: z.string().uuid().nullable(),
});

/** PATCH /api/v1/contacts/:id/person — associa contact a people (same org). */
export async function PATCH(req: NextRequest, { params }: Ctx): Promise<Response> {
  const requestId = requestIdOf(req);
  const desligado = await seModuloB2bDesligado(requestId);
  if (desligado) return desligado;
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  // Sessão OU token de integração (Spec 33, R2): `mcp:write` e papel `agent`.
  // A organização sai da sessão ou da LINHA DO TOKEN.
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "contacts",
    role: "agent",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "contacts", requestId);
  if (teto) return teto;
  const { id } = await params;

  try {
    const body = bodySchema.parse(await req.json());
    const supabase = authz.supabase;
    const ctx: HandlerCtx = {
      organization_id: authz.organizationId,
      actor: authz.actor,
      requestId,
      idioma: authz.idioma,
    };
    const data = await linkContactToPersonHandler(
      supabase,
      ctx,
      authz.actor.type === "user" ? authz.actor.id : null,
      id,
      body.person_id,
      authz.apiTokenId ?? null,
    );
    return ok(data, { requestId });
  } catch (e) {
    return handleRouteError(e, requestId);
  }
}
