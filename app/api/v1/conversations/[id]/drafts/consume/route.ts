import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { resolveAuthDual } from "@/lib/api/auth-dual";
import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { traduzir } from "@/lib/i18n/dicionario";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { validateRequest } from "@/lib/schemas";
import { consumirRascunho } from "@/lib/inbox/rascunho-sugerido";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/v1/conversations/[id]/drafts/consume — "usei o texto sugerido"
 * (issue #1611).
 *
 * Chamada pelo navegador DEPOIS do envio humano dar certo (`Composer`, no
 * `onSuccess` do envio). Não é uma porta de envio: ela só grava `consumed_at` e
 * `consumed_by_user_id`, com os guardas no próprio UPDATE (org, conversa, não
 * usado, não vencido) — idempotente por construção.
 *
 * `consumido: false` é resposta, não erro: a mensagem já saiu, e a falhar o
 * envio por causa do rascunho seria trocar o problema pelo pior.
 */
export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "conversations",
    role: "agent",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);

  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) {
    return fail("validation_error", t("Conversa inválida."), 422, { requestId });
  }

  let input;
  try {
    input = await validateRequest(z.object({ draft_id: z.string().uuid() }), req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  const userId = authz.actor.type === "user" ? authz.actor.id : null;
  const consumido = await consumirRascunho(authz.supabase, {
    organizationId: authz.organizationId,
    conversationId: id,
    draftId: input.draft_id,
    userId,
  });

  if (consumido) {
    await audit({
      action: "conversation.draft_used",
      actorUserId: userId,
      actorApiTokenId: authz.apiTokenId ?? null,
      organizationId: authz.organizationId,
      resourceType: "conversation",
      resourceId: id,
      requestId,
      metadata: { draft_id: input.draft_id },
    });
  }

  return ok({ consumido }, { requestId });
}
