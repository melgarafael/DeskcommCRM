/**
 * Resolve a sessão WaCalls pareada de uma organização — helper compartilhado
 * pelas rotas `app/api/v1/voice/*`. Nunca aceita `channel_session_id`/
 * `wacalls_session_id` vindo do body: sempre relido do banco, escopado pela
 * org da sessão autenticada.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface WacallsSessionRow {
  channelSessionId: string;
  wacallsSessionId: string;
}

export async function resolveWacallsSession(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  organizationId: string,
): Promise<WacallsSessionRow | null> {
  const { data } = await supabase
    .from("channel_sessions")
    .select("id, wacalls_session_id")
    .eq("organization_id", organizationId)
    .eq("provider", "wacalls")
    .is("archived_at", null)
    .maybeSingle();
  const row = data as { id: string; wacalls_session_id: string | null } | null;
  if (!row?.wacalls_session_id) return null;
  return { channelSessionId: row.id, wacallsSessionId: row.wacalls_session_id };
}
