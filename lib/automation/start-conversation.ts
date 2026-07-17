/**
 * Conversa programática p/ automação: acha a conversa aberta do contato na
 * sessão ou cria uma nova. Distinto da ingestão WAHA (que usa RPCs de
 * identidade) — aqui contato e sessão já são conhecidos.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

const OPEN_STATUSES = ["open", "pending", "claimed", "ai_handling"];

export async function ensureConversation(
  admin: SupabaseClient,
  organizationId: string,
  contactId: string,
  channelSessionId: string,
): Promise<string> {
  const { data: existing } = await admin
    .from("conversations")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .eq("channel_session_id", channelSessionId)
    .in("status", OPEN_STATUSES)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing) return (existing as { id: string }).id;

  const { data: created, error } = await admin
    .from("conversations")
    .insert({
      organization_id: organizationId,
      contact_id: contactId,
      channel_session_id: channelSessionId,
      channel: "whatsapp",
      status: "open",
      metadata: { created_by: "automation" },
    })
    .select("id")
    .single();
  if (error || !created) throw new Error(error?.message ?? "conversation_insert_failed");
  return (created as { id: string }).id;
}
