import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/conversations/[id]/claim — atendente assume a conversa.
 *
 * Concorrência: o UPDATE só vence se o assignee atual for NULL ou bater com
 * `expected_assignee` (optimistic lock). Se 0 linhas → 409 (outro atendente
 * já assumiu).
 *
 * G3-01: a mudança de dono acontece via rpc `fn_conversation_assign`
 * (migration 0031), que faz o UPDATE condicional + INSERT do evento em
 * `conversation_assignment_events` (reason='claim') na MESMA transação.
 *
 * 0173: essa mesma RPC agora grava `bot_silenced_until='infinity'` — assumir CALA
 * o atendimento automático. Antes disso o motor moderno nunca soube que alguém
 * assumiu (ele não lê `assignee_kind`) e os dois atendiam o mesmo cliente.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { assumirConversaComEfeitos } from "@/lib/inbox/assumir-conversa";
import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { claimConversationSchema, validateRequest } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  const supabase = await createClient();

  // spec 13 §4: escrita é agent+ (viewer é read-only).
  const authz = await requireRole("agent", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const user = authz.user;

  let input;
  try {
    input = await validateRequest(claimConversationSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  const { conversation: conv, error } = await assumirConversaComEfeitos(supabase, {
    organizationId: authz.org.orgId,
    conversationId: id,
    actor: { type: "user", id: user.id, role: authz.org.role },
    requestId,
    expectedAssignee: input.expected_assignee,
  });
  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!conv) return fail("state_conflict", t("Outro atendente já assumiu."), 409, { requestId });

  return ok(conv, { requestId });
}
