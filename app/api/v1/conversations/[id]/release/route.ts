/**
 * POST /api/v1/conversations/[id]/release — atendente solta a conversa que
 * havia assumido. Volta status='open' e limpa assignee.
 *
 * Só funciona se o caller for o atual `assigned_to_user_id` (filtro no
 * UPDATE). RLS adiciona isolamento de tenant.
 *
 * G3-01: a mudança de dono acontece via rpc `fn_conversation_assign`
 * (migration 0031) — UPDATE condicional + evento `reason='release'` em
 * `conversation_assignment_events` na MESMA transação.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import type { Conversation } from "@/lib/types/messaging";

export const dynamic = "force-dynamic";

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

  const { data, error } = await supabase.rpc("fn_conversation_assign", {
    p_organization_id: authz.org.orgId,
    p_conversation_id: id,
    // Release: volta à fila. A função aceita null (types gerados não expõem a nulabilidade do arg).
    p_to_user_id: null as unknown as string,
    p_reason: "release",
    p_expected_assignee: user.id,
    p_enforce_expected: true,
  });

  if (error) {
    return fail("internal_error", error.message, 500, { requestId });
  }
  const row = data?.[0];
  if (!row) {
    return fail("state_conflict", "Você não está atribuído a essa conversa.", 409, { requestId });
  }

  const conv = row as unknown as Conversation;

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
