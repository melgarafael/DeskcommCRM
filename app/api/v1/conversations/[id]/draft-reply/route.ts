import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { requestTurnDeps } from "@/lib/agent-engine/agent/request-deps";
import { generateReplyDraft } from "@/lib/agent-engine/agent/reply-drafts";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
async function context(ctx: Ctx, requestId: string) {
  const auth = await requireRole("agent", { requestId, resource: "conversations" });
  if (!auth.ok) return { response: auth.response } as const;
  const { id } = await ctx.params;
  const db = await createClient();
  const { data: conversation } = await db
    .from("conversations")
    .select("id,contact_id,channel_session_id")
    .eq("organization_id", auth.org.orgId)
    .eq("id", id)
    .maybeSingle();
  if (!conversation)
    return { response: fail("not_found", "Conversa não encontrada.", 404, { requestId }) } as const;
  return { auth, conversation } as const;
}
export async function GET(_req: NextRequest, ctx: Ctx) {
  const requestId = randomUUID(),
    c = await context(ctx, requestId);
  if ("response" in c) return c.response;
  const { rows } = await getRequestPool().query(
    `select id,revision::text,original_body,edited_body,approved_body,proposals,feedback,error_code,created_at,
 case when status in ('generating','pending','approved') and not fn_reply_context_current(organization_id,id) then 'stale' else status end as status
 from ai_reply_drafts where organization_id=$1 and conversation_id=$2 order by created_at desc limit 5`,
    [c.auth.org.orgId, c.conversation.id],
  );
  return ok({ drafts: rows }, { requestId });
}
export async function POST(_req: NextRequest, ctx: Ctx) {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const requestId = randomUUID(),
    c = await context(ctx, requestId);
  if ("response" in c) return c.response;
  const {
    contact_id: contactId,
    channel_session_id: channelId,
    id: conversationId,
  } = c.conversation;
  if (!contactId || !channelId)
    return fail("unprocessable", "Conversa sem contato/canal.", 422, { requestId });
  try {
    const draft = await generateReplyDraft(getRequestPool(), requestTurnDeps(), {
      organizationId: c.auth.org.orgId,
      conversationId,
      contactId,
      channelId,
    });
    void audit({
      action: "ai_reply.generated",
      actorUserId: c.auth.user.id,
      organizationId: c.auth.org.orgId,
      resourceType: "conversation",
      resourceId: conversationId,
      requestId,
    });
    return ok(
      { draft: draft.original_body ?? "", draft_id: draft.id, status: draft.status },
      { requestId },
    );
  } catch {
    return fail(
      "reply_unavailable",
      "Não foi possível gerar a sugestão. Confira a publicação e a configuração do agente.",
      422,
      { requestId },
    );
  }
}
