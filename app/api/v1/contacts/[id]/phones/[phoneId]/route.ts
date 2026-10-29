/**
 * PATCH  /api/v1/contacts/[id]/phones/[phoneId] — tipo, WhatsApp e rótulo do extra (Spec 31, B2).
 * DELETE /api/v1/contacts/[id]/phones/[phoneId] — remove o extra.
 *
 * Extra que não é desta ficha → 404 (a consulta filtra organização, ficha e id).
 * Corpo vazio → 422. Sessão + papel `agent` + `requireSupportWrite` antes do efeito.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ApiError } from "@/lib/api/types";
import { fail, noContent, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { telefoneExtraPatchSchema, validateRequest } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";

import { editarTelefoneExtra, ehUuid, removerTelefoneExtra } from "../_handler";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string; phoneId: string }> };

export async function PATCH(req: NextRequest, ctx: Context): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id, phoneId } = await ctx.params;

  const authz = await requireRole("agent", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;
  const user = authz.user;
  const activeOrg = authz.org;

  if (!ehUuid(id) || !ehUuid(phoneId)) {
    return fail("not_found", "Telefone não encontrado nesta ficha.", 404, { requestId });
  }

  let input;
  try {
    input = await validateRequest(telefoneExtraPatchSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  const supabase = await createClient();
  try {
    const extra = await editarTelefoneExtra(
      {
        supabase,
        organizationId: activeOrg.orgId,
        contactId: id,
        actorUserId: user.id,
        requestId,
        idioma: user.idioma,
      },
      phoneId,
      input,
    );
    return ok(extra, { requestId });
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, { requestId });
    }
    throw err;
  }
}

export async function DELETE(_req: NextRequest, ctx: Context): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id, phoneId } = await ctx.params;

  const authz = await requireRole("agent", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;
  const user = authz.user;
  const activeOrg = authz.org;

  if (!ehUuid(id) || !ehUuid(phoneId)) {
    return fail("not_found", "Telefone não encontrado nesta ficha.", 404, { requestId });
  }

  const supabase = await createClient();
  try {
    await removerTelefoneExtra(
      {
        supabase,
        organizationId: activeOrg.orgId,
        contactId: id,
        actorUserId: user.id,
        requestId,
        idioma: user.idioma,
      },
      phoneId,
    );
    return noContent(requestId);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, { requestId });
    }
    throw err;
  }
}
