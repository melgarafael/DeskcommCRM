/** Edição e revogação de mensagens de texto enviadas pelo próprio atendente. */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import {
  CHANNEL_SESSION_REF_COLUMNS,
  getAdapter,
  resolveSessionRef,
  transportaMensagem,
  type ChannelProvider,
  type ChannelSessionRef,
} from "@/lib/channels";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface Ctx { params: Promise<{ id: string }> }
const textoSchema = z.object({ text: z.string().trim().min(1).max(4096) });
const JANELA_EDICAO_MS = 15 * 60 * 1000;

async function alterar(req: NextRequest, ctx: Ctx, acao: "edit" | "revoke"): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "messages" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) {
    return fail("validation_failed", t("Dados inválidos."), 422, { requestId });
  }
  const parsed = acao === "edit" ? textoSchema.safeParse(await req.json().catch(() => null)) : null;
  if (parsed && !parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, { requestId });
  }

  const supabase = await createClient();
  const { data: message, error: messageError } = await supabase.from("messages")
    .select("id, organization_id, conversation_id, channel_session_id, external_id, direction, type, status, body, sent_via, sent_by_user_id, sent_at, revoked_at")
    .eq("id", id).eq("organization_id", authz.org.orgId).maybeSingle();
  if (messageError) return fail("internal_error", t("Erro ao buscar mensagem."), 500, { requestId });
  if (!message) return fail("not_found", t("Mensagem não encontrada."), 404, { requestId });

  // O WhatsApp só deixa o autor alterar uma mensagem própria. A UI esconde o
  // gesto dos demais, mas esta guarda no servidor impede chamar a rota à mão.
  if (message.direction !== "outbound" || !["user", "crm"].includes(message.sent_via)
    || message.sent_by_user_id !== authz.user.id || !message.external_id
    || message.revoked_at || !["sent", "delivered", "read"].includes(message.status)
    || (acao === "edit" && message.type !== "text")) {
    return fail("forbidden", t("Esta mensagem não pode ser alterada."), 403, { requestId });
  }
  if (acao === "edit" && Date.now() - new Date(message.sent_at).getTime() > JANELA_EDICAO_MS) {
    return fail("edit_window_closed", t("O prazo para editar esta mensagem terminou."), 409, { requestId });
  }
  if (acao === "edit" && parsed?.success && parsed.data.text === message.body) {
    return ok({ id: message.id, unchanged: true }, { requestId });
  }

  const { data: conversation, error: conversationError } = await supabase.from("conversations")
    .select("id, contact_id, is_group, channel_session_id")
    .eq("id", message.conversation_id).eq("organization_id", authz.org.orgId).maybeSingle();
  if (conversationError || !conversation || conversation.is_group || conversation.channel_session_id !== message.channel_session_id) {
    return fail("not_found", t("Conversa não encontrada."), 404, { requestId });
  }
  const [{ data: session }, { data: contact }] = await Promise.all([
    supabase.from("channel_sessions").select(`${CHANNEL_SESSION_REF_COLUMNS}, archived_at`)
      .eq("id", message.channel_session_id).eq("organization_id", authz.org.orgId).maybeSingle(),
    supabase.from("contacts").select("phone_number, wa_identity, wa_lid")
      .eq("id", conversation.contact_id).eq("organization_id", authz.org.orgId).maybeSingle(),
  ]);
  // O canal decide se sabe alterar: a rota testa a presença do método, nunca
  // QUAL provider é (invariante 1 de docs/doctrine/restricao-de-canal.md).
  const adapter = session && !session.archived_at && transportaMensagem(session.provider)
    ? getAdapter(session.provider as ChannelProvider) : null;
  const sessionRef = session ? resolveSessionRef(session as unknown as ChannelSessionRef) : null;
  if (!adapter?.editMessage || !adapter.revokeMessage || !sessionRef) {
    return fail("unsupported_channel", t("Este canal não permite alterar mensagens."), 409, { requestId });
  }
  if (!adapter.isConfigured()) {
    return fail("channel_unavailable", t("WhatsApp indisponível no momento."), 503, { requestId });
  }

  const alvo = {
    organizationId: authz.org.orgId,
    sessionRef,
    externalId: message.external_id,
    recipient: adapter.resolveRecipient({
      isGroup: false, groupChatId: null, phoneNumber: contact?.phone_number,
      waIdentity: contact?.wa_identity, waLid: contact?.wa_lid,
    }),
  };
  try {
    if (acao === "edit" && parsed?.success) {
      await adapter.editMessage({ ...alvo, text: parsed.data.text });
    } else {
      await adapter.revokeMessage(alvo);
    }
  } catch (err) {
    if (err instanceof Error && err.message === "recipient_unavailable") {
      return fail("recipient_unavailable", t("Contato sem WhatsApp válido."), 409, { requestId });
    }
    return fail("channel_error", t("O WhatsApp recusou a alteração da mensagem."), 502, { requestId });
  }

  const update = acao === "edit" && parsed?.success
    ? { body: parsed.data.text, edited_at: new Date().toISOString() }
    : { revoked_at: new Date().toISOString() };
  const { data: updated, error: updateError } = await supabase.from("messages")
    .update(update).eq("id", id).eq("organization_id", authz.org.orgId)
    .select("id, body, edited_at, revoked_at").maybeSingle();
  if (updateError || !updated) {
    return fail("internal_error", t("O WhatsApp alterou a mensagem, mas o CRM não conseguiu atualizar o histórico."), 500, { requestId });
  }
  // A lista de conversas guarda uma cópia da última prévia. Se esta mensagem
  // ainda for a última, atualizar a cópia evita mostrar texto já alterado.
  const { data: latest } = await supabase.from("messages").select("id")
    .eq("organization_id", authz.org.orgId).eq("conversation_id", message.conversation_id)
    .order("sent_at", { ascending: false }).limit(1).maybeSingle();
  if (latest?.id === id) {
    const antigoPreview = message.body?.slice(0, 280) || `[${message.type}]`;
    const novoPreview = acao === "edit" && parsed?.success
      ? parsed.data.text.slice(0, 280) : "Esta mensagem foi apagada";
    await supabase.from("conversations").update({ last_message_preview: novoPreview })
      .eq("id", message.conversation_id).eq("organization_id", authz.org.orgId)
      .eq("last_message_preview", antigoPreview);
  }
  await audit({
    action: acao === "edit" ? "message.edited" : "message.revoked",
    actorUserId: authz.user.id, organizationId: authz.org.orgId,
    resourceType: "message", resourceId: id, requestId,
    metadata: { conversation_id: message.conversation_id },
  });
  return ok(updated, { requestId });
}

export async function PATCH(req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  return alterar(req, ctx, "edit");
}

export async function DELETE(req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  return alterar(req, ctx, "revoke");
}
