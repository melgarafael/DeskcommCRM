/**
 * POST /api/v1/contacts/[id]/phones — adiciona um telefone à ficha (Spec 31, B2).
 *
 * Ficha sem principal → o número vira o principal: `{ became_primary: true }`.
 * Ficha com principal → vira extra: `201` com o extra (sem `wa_lid`).
 * Número inválido → 422 `invalid_phone`; número de outra ficha viva → 409 `phone_in_use`.
 *
 * Thin wrapper: sessão + papel `agent` + `requireSupportWrite` antes do efeito +
 * Zod + envelope. A regra mora em `./_handler.ts`. Sem bearer (sem entrada em
 * `lib/auth/public-paths.ts`), como as demais rotas de contato.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { telefoneExtraCreateSchema, validateRequest } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";

import { adicionarTelefone, ehUuid } from "./_handler";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Context): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("agent", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;
  const user = authz.user;
  const activeOrg = authz.org;

  if (!ehUuid(id)) {
    return fail("not_found", "Contato não encontrado.", 404, { requestId });
  }

  let input;
  try {
    input = await validateRequest(telefoneExtraCreateSchema, req);
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
    const resultado = await adicionarTelefone(
      {
        supabase,
        organizationId: activeOrg.orgId,
        contactId: id,
        actorUserId: user.id,
        requestId,
        idioma: user.idioma,
      },
      input,
    );
    if ("became_primary" in resultado) return ok(resultado, { requestId });
    return ok(resultado, { status: 201, requestId });
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }
}
