/**
 * Busca o ai_agent configurado como agente de VOZ pra uma org
 * (ai_agents.channel = 'voice', coluna aditiva da migration 0232).
 */

import { createAdminClient } from "@/lib/supabase/admin";

export interface VoiceAgentConfig {
  id: string;
  systemPrompt: string;
}

export async function getActiveVoiceAgent(organizationId: string): Promise<VoiceAgentConfig | null> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("ai_agents")
    .select("id, system_prompt")
    .eq("organization_id", organizationId)
    .eq("channel", "voice")
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;
  return { id: data.id, systemPrompt: data.system_prompt };
}
