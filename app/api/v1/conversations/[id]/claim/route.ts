/**
 * POST /api/v1/conversations/[id]/claim — atendente assume a conversa.
 *
 * Concorrência: o UPDATE só vence se o assignee atual for NULL ou bater com
 * `expected_assignee` (optimistic lock). Se 0 linhas → 409 (outro atendente
 * já assumiu).
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

const SELECT_COLS = `
  id, organization_id, contact_id, channel_session_id, channel, status,
  status_changed_at, assigned_to_user_id, assigned_at, last_inbound_at,
  last_outbound_at, last_message_at, last_message_preview,
  unread_count_for_assignee, is_group, group_chat_id, metadata,
  created_at, updated_at
`;

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

  const now = new Date().toISOString();
  let query = supabase
    .from("conversations")
    .update({
      assigned_to_user_id: user.id,
      assigned_at: now,
      status: "claimed",
      status_changed_at: now,
    })
    .eq("id", id);

  // Optimistic lock: aceitamos null (livre) OU bater com expected_assignee.
  if (input.expected_assignee === undefined) {
    query = query.is("assigned_to_user_id", null);
  } else if (input.expected_assignee === null) {
    query = query.is("assigned_to_user_id", null);
  } else {
    query = query.eq("assigned_to_user_id", input.expected_assignee);
  }

  const { data, error } = await query.select(SELECT_COLS).maybeSingle();

  if (error) {
    return fail("internal_error", error.message, 500, { requestId });
  }
  if (!data) {
    return fail("state_conflict", "Outro atendente já assumiu.", 409, { requestId });
  }

  const conv = data as unknown as Conversation;

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
