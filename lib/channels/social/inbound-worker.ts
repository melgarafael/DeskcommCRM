import type { EventHandler } from "@/lib/event-log/dispatcher";
import { createAdminClient } from "@/lib/supabase/admin";

/** O evento transacional guarda só referência; conteúdo permanece na mensagem sob RLS. */
export const socialInboundHandler: EventHandler = {
  key: "social_inbound_v1",
  events: ["social.dm_received"],
  async handle(row) {
    const db = createAdminClient();
    const { data: msg, error } = await db
      .from("messages")
      .select("id,conversation_id,contact_id,channel_session_id,body,direction")
      .eq("organization_id", row.organization_id)
      .eq("id", row.entity_id)
      .maybeSingle();
    if (error) throw new Error("social_inbound_lookup_failed");
    if (!msg) return { consumer_key: this.key, status: "skipped", detail: "message_removed" };
    if (msg.direction !== "inbound" || !msg.contact_id || !msg.channel_session_id)
      throw new Error("social_inbound_identity_invalid");
    const { aplicarEfeitosPosEntrada } = await import("../pos-entrada");
    await aplicarEfeitosPosEntrada(db, {
      organizationId: row.organization_id,
      contactId: msg.contact_id,
      conversationId: msg.conversation_id,
      channelSessionId: msg.channel_session_id,
      messageId: msg.id,
      texto: msg.body,
      nomeDoContato: null,
      origem: "social_inbound",
      retryOnFailure: true,
    });
    return { consumer_key: this.key, status: "ok" };
  },
};
