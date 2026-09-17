import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { requestTurnDeps } from "@/lib/agent-engine/agent/request-deps";
import { generateReplyDraft } from "@/lib/agent-engine/agent/reply-drafts";
import { motivoDaFalha } from "@/lib/agent-engine/agent/sugestao-de-resposta";
import { logger } from "@/lib/logger";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { traduzir } from "@/lib/i18n/dicionario";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
async function context(ctx: Ctx, requestId: string) {
  const auth = await requireRole("agent", { requestId, resource: "conversations" });
  if (!auth.ok) return { response: auth.response } as const;
  const t = (texto: string) => traduzir(texto, auth.user.idioma);
  const { id } = await ctx.params;
  const db = await createClient();
  const { data: conversation } = await db
    .from("conversations")
    .select("id,contact_id,channel_session_id")
    .eq("organization_id", auth.org.orgId)
    .eq("id", id)
    .maybeSingle();
  if (!conversation)
    return { response: fail("not_found", t("Conversa não encontrada."), 404, { requestId }) } as const;
  return { auth, conversation, t } as const;
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
    return fail("unprocessable", c.t("Conversa sem contato/canal."), 422, { requestId });
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
  } catch (erro) {
    const motivo = motivoDaFalha(erro);
    // O `catch` daqui era SEM NOME, e a causa morria nesta linha. Registrar é
    // metade do conserto: a outra metade é a frase, que antes mandava conferir
    // a publicação do agente mesmo quando o problema era outro.
    logger.error("[draft-reply] não foi possível gerar a sugestão", {
      requestId,
      organizationId: c.auth.org.orgId,
      conversationId,
      motivo: motivo.codigo,
      erro: erro instanceof Error ? erro.message : String(erro),
    });
    return fail(motivo.codigo, c.t(motivo.texto), 422, { requestId });
  }
}
