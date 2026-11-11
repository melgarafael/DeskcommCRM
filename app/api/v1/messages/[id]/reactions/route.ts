import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { CHANNEL_SESSION_REF_COLUMNS, getAdapter, resolveSessionRef, transportaMensagem, type ChannelProvider, type ChannelSessionRef } from "@/lib/channels";
import { enderecoDaUltimaRecebida } from "@/lib/channels/endereco-da-ultima-recebida";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
const schema = z.object({ emoji: z.string().min(1).max(32).refine((emoji) => {
  const graphemes = [...new Intl.Segmenter("pt", { granularity: "grapheme" }).segment(emoji)];
  return graphemes.length === 1 && /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u.test(emoji)
    && !/[\p{Cc}\u200B\u200C\u2060]/u.test(emoji);
}, "Emoji inválido") });

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const requestId = randomUUID();
  const auth = await requireRole("agent", { requestId, resource: "messages" });
  if (!auth.ok) return auth.response;
  const t = (texto: string) => traduzir(texto, auth.user.idioma);
  const { id } = await ctx.params;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!z.string().uuid().safeParse(id).success || !parsed.success) return fail("validation_failed", t("Dados inválidos."), 422, { requestId });
  const db = await createClient();
  const org = auth.org.orgId;
  const { data: target, error: targetError } = await db.from("messages")
    .select("id, organization_id, conversation_id, contact_id, channel_session_id, external_id, type, revoked_at")
    .eq("id", id).eq("organization_id", org).maybeSingle();
  if (targetError) return fail("internal_error", t("Erro ao buscar mensagem."), 500, { requestId });
  if (!target || !target.external_id || target.revoked_at || target.type === "reaction") return fail("not_found", t("Mensagem não encontrada."), 404, { requestId });
  const { data: conversation } = await db.from("conversations").select("id, contact_id, is_group, group_chat_id, channel_session_id")
    .eq("id", target.conversation_id).eq("organization_id", org).maybeSingle();
  if (!conversation || conversation.channel_session_id !== target.channel_session_id) return fail("not_found", t("Conversa não encontrada."), 404, { requestId });
  const [{ data: session }, { data: contact }] = await Promise.all([
    db.from("channel_sessions").select(`${CHANNEL_SESSION_REF_COLUMNS}, archived_at`).eq("id", target.channel_session_id).eq("organization_id", org).maybeSingle(),
    db.from("contacts").select("phone_number, wa_identity, wa_lid, is_blocked, is_personal").eq("id", conversation.contact_id).eq("organization_id", org).maybeSingle(),
  ]);
  // Reação também chega ao celular do contato: as mesmas recusas do envio (_handler.ts).
  if (contact?.is_blocked) return fail("forbidden", t("Contato bloqueou o atendimento."), 403, { requestId });
  if (contact?.is_personal === true) return fail("forbidden", t("Contato marcado como pessoal."), 403, { requestId });
  const adapter = session && !session.archived_at && transportaMensagem(session.provider) ? getAdapter(session.provider as ChannelProvider) : null;
  const sessionRef = session ? resolveSessionRef(session as ChannelSessionRef) : null;
  if (!adapter?.sendReaction || !sessionRef) return fail("unsupported_channel", t("Este canal não permite reações."), 409, { requestId });
  if (!adapter.isConfigured()) return fail("channel_unavailable", t("WhatsApp indisponível no momento."), 503, { requestId });
  const ultimoRecebidoChatId = await enderecoDaUltimaRecebida(db, { provider: session?.provider, isGroup: conversation.is_group, organizationId: org, conversationId: conversation.id, contactId: conversation.contact_id });
  const recipient = adapter.resolveRecipient({ isGroup: conversation.is_group, groupChatId: conversation.group_chat_id, phoneNumber: contact?.phone_number, waIdentity: contact?.wa_identity, waLid: contact?.wa_lid, ultimoRecebidoChatId });
  let externalId: string | null;
  try {
    ({ externalId } = await adapter.sendReaction({ organizationId: org, sessionRef, recipient, externalId: target.external_id, emoji: parsed.data.emoji }));
  } catch (err) {
    if (err instanceof Error && err.message === "recipient_unavailable") {
      return fail("recipient_unavailable", t("Contato sem WhatsApp válido."), 409, { requestId });
    }
    return fail("channel_error", t("O WhatsApp recusou a reação."), 502, { requestId });
  }
  await audit({
    action: "message.reaction_sent", actorUserId: auth.user.id, organizationId: org,
    resourceType: "message", resourceId: id, requestId,
    metadata: { conversation_id: target.conversation_id, external_id: target.external_id, reaction_external_id: externalId },
  });
  // O eco do webhook pode chegar antes desta escrita; a chave externa única impede duplicatas.
  if (!externalId) return ok({ sent: true }, { requestId });
  const { error } = await db.from("messages").insert({
    organization_id: org, conversation_id: target.conversation_id, contact_id: target.contact_id,
    channel_session_id: target.channel_session_id, external_id: externalId, type: "reaction",
    direction: "outbound", status: "sent", body: null, sent_at: new Date().toISOString(),
    sent_via: "user", sent_by_user_id: auth.user.id, reply_to_message_id: target.id,
    metadata: { reaction: { emoji: parsed.data.emoji, target_external_id: target.external_id, author: "me" } },
  });
  if (error && error.code !== "23505") return fail("internal_error", t("Reação enviada, mas histórico não atualizado."), 500, { requestId });
  return ok({ sent: true, externalId }, { requestId });
}
