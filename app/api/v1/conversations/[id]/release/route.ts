/**
 * POST /api/v1/conversations/[id]/release — atendente solta a conversa que
 * havia assumido. Volta status='open' e limpa assignee.
 *
 * Só funciona se o caller for o atual `assigned_to_user_id` (filtro no
 * UPDATE). RLS adiciona isolamento de tenant.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
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

export async function POST(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  const supabase = await createClient();

  // spec 13 §4: escrita é agent+ (viewer é read-only).
  const authz = await requireRole("agent", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const user = authz.user;

  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("conversations")
    .update({
      assigned_to_user_id: null,
      assigned_at: null,
      status: "open",
      status_changed_at: now,
    })
    .eq("id", id)
    .eq("assigned_to_user_id", user.id)
    .select(SELECT_COLS)
    .maybeSingle();

  if (error) {
    return fail("internal_error", error.message, 500, { requestId });
  }
  if (!data) {
    return fail("state_conflict", "Você não está atribuído a essa conversa.", 409, { requestId });
  }

  const conv = data as unknown as Conversation;

  await audit({
    action: "conversation.released",
    actorUserId: user.id,
    organizationId: conv.organization_id,
    resourceType: "conversation",
    resourceId: conv.id,
    requestId,
  });

  return ok(conv, { requestId });
}
