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
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { claimConversationSchema, validateRequest } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";
import type { Conversation } from "@/lib/types/messaging";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  const supabase = await createClient();

  // spec 13 §4: escrita é agent+ (viewer é read-only).
  const authz = await requireRole("agent", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
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

  // Optimistic lock (spec 04 §9.2): expected null/omitido = só assume se livre;
  // expected uuid = takeover consciente. UPDATE + evento na mesma transação.
  const { data, error } = await supabase.rpc("fn_conversation_assign", {
    p_organization_id: authz.org.orgId,
    p_conversation_id: id,
    p_to_user_id: user.id,
    p_reason: "claim",
    ...(input.expected_assignee ? { p_expected_assignee: input.expected_assignee } : {}),
    p_enforce_expected: true,
  });

  if (error) {
    return fail("internal_error", error.message, 500, { requestId });
  }
  const row = data?.[0];
  if (!row) {
    return fail("state_conflict", "Outro atendente já assumiu.", 409, { requestId });
  }

  const conv = row as unknown as Conversation;

  await audit({
    action: "conversation.claimed",
    actorUserId: user.id,
    organizationId: conv.organization_id,
    resourceType: "conversation",
    resourceId: conv.id,
    requestId,
  });

  await supabase
    .rpc("emit_event", {
      p_event_type: "conversation.claimed",
      p_entity_kind: "conversation",
      p_entity_id: conv.id,
      p_payload: { assigned_to_user_id: user.id },
      p_metadata: { request_id: requestId },
      p_organization_id: conv.organization_id,
    })
    .then(({ error: emitErr }) => {
      if (emitErr) console.error("[conversation.claim] emit_event failed", emitErr.message);
    });

  return ok(conv, { requestId });
}
