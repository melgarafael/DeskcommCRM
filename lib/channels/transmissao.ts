/**
 * A TRANSMISSÃO DO PROVEDOR (migration 0712): o provedor recebe a lista inteira
 * e um modelo aprovado, manda a todos de uma vez e devolve o relatório por
 * destinatário. É a terceira velocidade da campanha, ao lado da gradual e da
 * rápida — e a única em que quem dispara é o provedor, não a rodada.
 *
 * Quem pergunta se um número faz transmissão é a capability (`transmissao` em
 * `capabilities.ts`); quem fala com o provedor é a implementação dele, achada
 * aqui pelo `provider` da conexão. A campanha só conhece este contrato.
 *
 * Os valores do modelo são os MESMOS para todos: o provedor não recebe valor por
 * destinatário. Medido em 16/10/2026: o mapeamento de variável que ele documenta
 * ("o nome de cada contato") chegou ao destinatário como "{{1}}", e o nome que
 * ele guarda de cada contato é o próprio número. Por isso a campanha só oferece a
 * transmissão quando toda variável é texto fixo, e manda o valor já escrito.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { canalTemTransmissao } from "./capabilities";
import type { EscopoDaTransmissao, OpsDeTransmissao } from "./transmissao-tipos";
import { transmissaoDoParceiro } from "./zernio/transmissao";

export * from "./transmissao-tipos";

/** A transmissão da conexão, ou `null` quando o número não faz transmissão. */
export async function transmissaoDaConexao(
  admin: SupabaseClient,
  escopo: EscopoDaTransmissao,
): Promise<OpsDeTransmissao | null> {
  const { data } = await admin
    .from("channel_sessions")
    .select("provider")
    .eq("organization_id", escopo.organizationId)
    .eq("id", escopo.channelSessionId)
    .maybeSingle();
  const provider = (data as { provider?: string | null } | null)?.provider ?? null;
  if (!canalTemTransmissao(provider)) return null;
  return transmissaoDoParceiro(admin, escopo);
}
