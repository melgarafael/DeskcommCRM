import type { SupabaseClient } from "@supabase/supabase-js";

import { dayStartInTz } from "@/lib/agent-engine/pacing/engine";

import type { EstadoDoEnvio } from "./ritmo";

/**
 * Quantas saíram hoje e na última hora, mais o último envio — o estado do ritmo.
 *
 * Conta com `count`, não pelo tamanho da resposta: o PostgREST corta a resposta
 * em `max_rows` (1.000 em `supabase/config.toml`), e a conta pelo tamanho parava
 * ali, deixando passar qualquer teto acima de 1.000.
 */
export async function estadoDeEnvio(
  admin: SupabaseClient,
  campanhaId: string,
  agora: Date,
  fuso: string,
): Promise<EstadoDoEnvio> {
  // O dia do teto diário é o dia DO CLIENTE, como o resto do ritmo. Ver a nota
  // no chamador: `setUTCHours` fazia o dia virar 21h em `America/Sao_Paulo`.
  const inicioDoDia = dayStartInTz(agora, fuso).toISOString();
  const quantasDesde = async (corte: string): Promise<number> => {
    const { count, error } = await admin
      .from("campaign_recipients")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campanhaId)
      .gte("sent_at", corte);
    // Sem a conta, zero seria "nada saiu", e o teto deixaria passar: a rodada cai.
    if (error) throw new Error(`envios da campanha: ${error.message}`);
    return count ?? 0;
  };
  const { data, error } = await admin
    .from("campaign_recipients")
    .select("sent_at")
    .eq("campaign_id", campanhaId)
    .gte("sent_at", inicioDoDia)
    .order("sent_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`último envio da campanha: ${error.message}`);
  const ultimo = (data ?? [])[0] as { sent_at: string } | undefined;
  return {
    ultimoEnvio: ultimo ? new Date(ultimo.sent_at) : null,
    enviadasHoje: await quantasDesde(inicioDoDia),
    enviadasNaUltimaHora: await quantasDesde(new Date(agora.getTime() - 3_600_000).toISOString()),
  };
}
