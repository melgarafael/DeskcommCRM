import type { SupabaseClient } from "@supabase/supabase-js";
import { parseServiceBoundary, type ServiceBoundary } from "./fronteira";

/** Mensagem persistida é a origem; nenhum fallback para a conversa atual. */
export async function serviceFromMessage(
  admin: SupabaseClient,
  org: string,
  messageId: string,
): Promise<ServiceBoundary | null> {
  const { data, error } = await admin
    .from("messages")
    .select(
      "organization_id,contact_id,conversation_id,service_revision,demanda_id,demanda_revision",
    )
    .eq("organization_id", org)
    .eq("id", messageId)
    .eq("direction", "inbound")
    .maybeSingle();
  if (error) throw error;
  const boundary = parseServiceBoundary(data);
  return boundary?.organization_id === org ? boundary : null;
}
