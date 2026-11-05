/**
 * Recusar uma ligação SIP que está tocando (`POST /api/v1/voice/calls/[id]/reject`).
 *
 * A rota só conhecia o WaCalls: em ligação SIP ela respondia 404 (a linha não
 * tem sessão WaCalls) e a tela escondia o banner só em memória. Recarregou,
 * voltou.
 *
 * O app não fala com o Asterisk: as credenciais do ARI vivem só no contêiner do
 * `voice-agent`. Por isso a recusa é um fato no BANCO: a linha vira `ended` com
 * `declined`, e quem age no canal é o worker. Quando o AudioSocket conecta e
 * encontra a linha encerrada, ele fecha o socket sem abrir a sessão de IA, e o
 * dialplan (`[from-trunk-audiosocket]`) segue para o `Hangup()`. Ligação que já
 * caiu (a linha fantasma) só precisa da linha encerrada.
 *
 * O filtro de status no UPDATE é o claim: ligação atendida entre o clique e a
 * escrita não é encerrada por baixo da conversa.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** Estados de antes de alguém atender. Recusar só faz sentido neles. */
const TOCANDO = ["starting", "ringing"] as const;

/** O motivo que o WaCalls usa para a recusa, e que `lib/cold-call/regras.ts` lê como "recusada". */
export const END_REASON_RECUSADA = "declined";

export type ResultadoDaRecusa = "recusada" | "ja_encerrada" | "ja_atendida" | "nao_encontrada";

export async function recusarChamadaSip(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  organizationId: string,
  voiceCallId: string,
  agora: Date,
): Promise<ResultadoDaRecusa> {
  const { data: recusadas, error } = await supabase
    .from("voice_calls")
    .update({ status: "ended", end_reason: END_REASON_RECUSADA, ended_at: agora.toISOString() })
    .eq("organization_id", organizationId)
    .eq("id", voiceCallId)
    .eq("provider", "sip")
    .eq("direction", "inbound")
    .in("status", [...TOCANDO])
    .select("id");
  if (error) throw new Error(`recusa_falhou: ${error.message}`);
  if ((recusadas ?? []).length > 0) return "recusada";

  // Nada mudou: diz POR QUÊ, para a tela não tratar "já acabou" como erro.
  const { data: linha, error: leituraErr } = await supabase
    .from("voice_calls")
    .select("status")
    .eq("organization_id", organizationId)
    .eq("id", voiceCallId)
    .eq("provider", "sip")
    .eq("direction", "inbound")
    .maybeSingle();
  if (leituraErr) throw new Error(`recusa_falhou: ${leituraErr.message}`);
  if (!linha) return "nao_encontrada";
  return (linha as { status: string }).status === "ended" ? "ja_encerrada" : "ja_atendida";
}
