import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PATCH /api/v1/leads/[id] — update lead (handler em ../_handler.ts).
 *
 * Aceita sessão de navegador OU token de servidor (`dsk_…` com `mcp:write`),
 * mesma dualidade de `/api/v1/messages`: a integração de monitoramento
 * processual (n8n consultando Escavador/Jusbrasil/Codilo/Judit) atualiza o
 * campo personalizado "Andamento atual" por aqui, sem navegador. A org nunca
 * vem do corpo — no ramo do token ela sai da linha do token
 * (`lib/api/auth-dual.ts`).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { updateLeadSchema, validateRequest } from "@/lib/schemas";

import { updateLeadHandler } from "../_handler";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id: leadId } = await ctx.params;

  // spec 13 §4: escrita é agent+ (viewer é read-only).
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "crm_leads",
    role: "agent",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  const { supabase, organizationId, actor, idioma } = authz;

  const tetoEstourado = await tetoDeEscritaDoToken(authz, "leads", requestId);
  if (tetoEstourado) return tetoEstourado;

  let input;
  try {
    input = await validateRequest(updateLeadSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  try {
    const updated = await updateLeadHandler(
      supabase,
      {
        organization_id: organizationId,
        actor,
        requestId,
        idioma,
      },
      leadId,
      input,
    );
    return ok(updated, { requestId });
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, { requestId });
    }
    throw err;
  }
}
