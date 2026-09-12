/**
 * Resolve uma chamada (`voice_calls`) da organização + a sessão WaCalls dona
 * dela, num só round-trip — compartilhado pelas rotas de webrtc/accept/
 * reject/end. O `id` do path é sempre o NOSSO uuid, nunca o `wacalls_call_id`
 * upstream (esse não vaza pro frontend).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface VoiceCallWithSession {
  id: string;
  wacallsCallId: string;
  wacallsSessionId: string;
  status: string;
  contactId: string | null;
  /** Quem está NA LINHA. `null` numa chamada recebida que ninguém atendeu ainda. */
  ownerUserId: string | null;
  /** Quem discou pelo CRM. `null` em toda ligação recebida. */
  createdBy: string | null;
}

/**
 * Só quem está na linha desliga.
 *
 * `lib/wacalls/calls.ts` escopava a chamada apenas pela organização, e o efeito
 * era que qualquer `agent` da org derrubava a ligação de qualquer colega — sem
 * rastro, no meio da frase. Num escritório que compartilha um número, isso não
 * é hipótese de laboratório: é o botão vermelho do painel de outra pessoa.
 *
 * A regra é a mais estreita que ainda funciona:
 *
 *  - alguém está na linha (`ownerUserId`) → só essa pessoa;
 *  - ninguém assumiu ainda e a chamada saiu do CRM → quem discou;
 *  - nenhum dos dois → não há áudio de ninguém para cortar, e o caminho certo é
 *    recusar (`/reject`), não desligar.
 */
export function podeEncerrar(call: VoiceCallWithSession, userId: string): boolean {
  if (call.ownerUserId) return call.ownerUserId === userId;
  return call.createdBy !== null && call.createdBy === userId;
}

export async function resolveVoiceCall(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  organizationId: string,
  voiceCallId: string,
): Promise<VoiceCallWithSession | null> {
  const { data } = await supabase
    .from("voice_calls")
    .select(
      "id, wacalls_call_id, status, contact_id, owner_user_id, created_by, channel_sessions!inner(wacalls_session_id)",
    )
    .eq("organization_id", organizationId)
    .eq("id", voiceCallId)
    .maybeSingle();
  const row = data as {
    id: string;
    wacalls_call_id: string;
    status: string;
    contact_id: string | null;
    owner_user_id: string | null;
    created_by: string | null;
    channel_sessions: { wacalls_session_id: string | null } | null;
  } | null;
  if (!row?.channel_sessions?.wacalls_session_id) return null;
  return {
    id: row.id,
    wacallsCallId: row.wacalls_call_id,
    wacallsSessionId: row.channel_sessions.wacalls_session_id,
    status: row.status,
    contactId: row.contact_id,
    ownerUserId: row.owner_user_id,
    createdBy: row.created_by,
  };
}
