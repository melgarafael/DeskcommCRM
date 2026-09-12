/**
 * DESPAREAR DE VERDADE — o ato que faltava para "desligar" não ser um rótulo.
 *
 * ═══ O QUE NÃO EXISTIA ═══
 *
 * O cliente do WaCalls tinha `logoutSession` e `deleteSession` desde o primeiro
 * dia, e NENHUMA rota os chamava. Só existia o botão "parear". Quem ligasse a
 * chamada de voz vinculava um segundo aparelho ao número da empresa e não tinha
 * caminho de volta: apagar a linha do banco esconderia a feature da tela e
 * deixaria o linked device de pé, do lado do WhatsApp, para sempre. "Desligar"
 * seria um rótulo sobre nada — e o risco que o desligamento existe para
 * encerrar continuaria correndo.
 *
 * ═══ A ORDEM É LOGOUT, DEPOIS DELETE, DEPOIS O BANCO ═══
 *
 * O molde é `app/api/v1/channel-sessions/[id]/route.ts`, que faz exatamente
 * esse par para o transporte de mensagens. `logout` derruba o vínculo com o
 * WhatsApp; `delete` remove a conta do processo. Invertido, a conta some antes de o vínculo cair e
 * fica um aparelho vinculado que ninguém consegue mais endereçar.
 *
 * ═══ O BANCO SÓ MUDA DEPOIS QUE O OUTRO LADO CONFIRMOU ═══
 *
 * Se o WaCalls falhar, esta função LANÇA e a linha NÃO é arquivada. É
 * deliberado: arquivar assim mesmo faria a tela dizer "desconectado" com o
 * aparelho ainda vinculado — a mentira exata que a feature toda existe para não
 * contar. Falhar fechado na AÇÃO; quem chama traduz o erro para quem lê.
 *
 * ═══ ARQUIVAR, NÃO APAGAR ═══
 *
 * `archived_at` é o que `lib/wacalls/session.ts` e a rota de status já filtram
 * (`.is("archived_at", null)`), então arquivar basta para a feature sumir. E a
 * linha sobrevive como âncora das FKs — apagá-la levaria junto o histórico de
 * chamadas que aponta para ela.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { WacallsClient } from "@/lib/wacalls/client";

export interface ResultadoDoDesparear {
  /** `false` quando não havia nada pareado — desparear o nada é sucesso, não erro. */
  desapareado: boolean;
  channelSessionId: string | null;
}

export async function despareaVoz(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  wacalls: WacallsClient,
  organizationId: string,
): Promise<ResultadoDoDesparear> {
  const { data } = await supabase
    .from("channel_sessions")
    .select("id, wacalls_session_id")
    .eq("organization_id", organizationId)
    .eq("provider", "wacalls")
    .is("archived_at", null)
    .maybeSingle();

  const linha = data as { id: string; wacalls_session_id: string | null } | null;

  // Idempotente por construção: desligar duas vezes, ou desligar sem nunca ter
  // pareado, não pode virar erro na cara de quem está justamente tentando
  // reduzir risco.
  if (!linha) return { desapareado: false, channelSessionId: null };

  if (linha.wacalls_session_id) {
    // Sem try/catch: erro daqui sobe e o chamador NÃO arquiva. Engolir seria
    // dizer "desconectado" com o aparelho vinculado.
    await wacalls.logoutSession(linha.wacalls_session_id);
    await wacalls.deleteSession(linha.wacalls_session_id);
  }

  const agora = new Date().toISOString();
  const { error } = await supabase
    .from("channel_sessions")
    .update({
      archived_at: agora,
      status: "STOPPED",
      last_status_change_at: agora,
      // A identidade do lado do WaCalls deixou de existir; guardá-la faria um
      // pareamento futuro tentar reusar um id que o processo não conhece mais.
      wacalls_session_id: null,
      wacalls_paired_at: null,
    })
    .eq("organization_id", organizationId)
    .eq("id", linha.id);

  if (error) throw new Error(`channel_sessions archive: ${error.message}`);

  return { desapareado: true, channelSessionId: linha.id };
}
