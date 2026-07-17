/**
 * POST /api/v1/conversations/[id]/transfer — reatribui a conversa a outro
 * atendente. Decisão G1-06d (spec 13 §5): transferência é IMEDIATA, sem etapa
 * de aceite do destino.
 *
 * G3-01: a mudança de dono acontece via rpc `fn_conversation_assign`
 * (migration 0031) — UPDATE de assigned_to_user_id + INSERT do evento
 * `reason='transfer'` em `conversation_assignment_events` na MESMA transação,
 * com `unread_count_for_assignee` re-zerado pro novo dono.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit, isServiceRoleConfigured } from "@/lib/audit";
import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { transferConversationSchema, validateRequest } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
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
  const orgId = authz.org.orgId; // fonte confiável (cookie validado), nunca o body

  let input;
  try {
    input = await validateRequest(transferConversationSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  // Destino tem que ser membro ativo agent+ da MESMA org (a RLS de
  // user_organizations só mostra o próprio membership a um agent — por isso o
  // admin client, filtrado pela org resolvida acima).
  if (isServiceRoleConfigured()) {
    const admin = createAdminClient();
    const { data: member, error: memberErr } = await admin
      .from("user_organizations")
      .select("role")
      .eq("organization_id", orgId)
      .eq("user_id", input.to_user_id)
      .is("revoked_at", null)
      .maybeSingle();
    if (memberErr) {
      return fail("internal_error", memberErr.message, 500, { requestId });
    }
    if (!member || member.role === "viewer") {
      return fail("unprocessable_entity", "Destino não é um atendente desta organização.", 422, {
        requestId,
      });
    }
  }

  const { data, error } = await supabase.rpc("fn_conversation_assign", {
    p_organization_id: orgId,
    p_conversation_id: id,
    p_to_user_id: input.to_user_id,
    p_reason: "transfer",
    // Imediata (G1-06d): sem optimistic lock — reatribui qualquer que seja o dono atual.
    p_enforce_expected: false,
  });

  if (error) {
    return fail("internal_error", error.message, 500, { requestId });
  }
  const row = data?.[0];
  if (!row) {
    return fail("not_found", "Conversa não encontrada.", 404, { requestId });
  }

  const conv = row as unknown as Conversation;

  await audit({
    action: "conversation.transferred",
    actorUserId: user.id,
    organizationId: conv.organization_id,
    resourceType: "conversation",
    resourceId: conv.id,
    requestId,
    metadata: {
      to_user_id: input.to_user_id,
      ...(input.reason ? { note: input.reason } : {}),
    },
  });

  // Notificação ao destino (G1-06d): evento no bus; worker/Realtime consome.
  await supabase
    .rpc("emit_event", {
      p_event_type: "conversation.transferred",
      p_entity_kind: "conversation",
      p_entity_id: conv.id,
      p_payload: { assigned_to_user_id: input.to_user_id, transferred_by: user.id },
      p_metadata: { request_id: requestId },
      p_organization_id: conv.organization_id,
    })
    .then(({ error: emitErr }) => {
      if (emitErr) console.error("[conversation.transfer] emit_event failed", emitErr.message);
    });

  return ok(conv, { requestId });
}
