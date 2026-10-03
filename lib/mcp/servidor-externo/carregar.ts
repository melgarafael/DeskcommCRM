/**
 * A ponte entre o REGISTRO (o jsonb) e o TURNO: lê, descobre e devolve pronto
 * para `pickToolsFromMcp` montar (#2147).
 *
 * ── Por que a descoberta mora aqui e não dentro do montador ─────────────────
 *
 * `pickToolsFromMcp` é síncrono — ele compõe tools a partir de definições que
 * já estão na mão. Listar ferramentas é rede. Fazer a rede ANTES, e passar o
 * resultado como dado, é o que mantém o montador puro e o turno dono do
 * orçamento de tempo.
 *
 * ── Por que falha vira `null` e não exceção ─────────────────────────────────
 *
 * O ERP registrado é um sistema alheio: pode estar desligado, atrás de
 * firewall, com a chave trocada. Nada disso é defeito do turno — sem as
 * ferramentas remotas o agente continua com o catálogo compilado, que é o
 * estado de antes do registro. Lançar aqui derrubaria a virada de turno inteira
 * por causa de um terceiro fora do ar, e é o registro que o operador pode
 * desligar, não o agente.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { listarFerramentasDoServidor, type FerramentaRemota } from "./chamada";
import { lerServidorMcpExterno, type ServidorMcpExterno } from "./registro";

/** O que o montador do turno recebe: a configuração e o que o servidor anunciou. */
export interface ServidorMcpExternoMontado {
  servidor: ServidorMcpExterno;
  ferramentas: readonly FerramentaRemota[];
}

/**
 * `null` = não há servidor registrado (ou não deu para falar com ele). É o
 * contrato do chamador: `...(montado ? { servidorMcpExterno: montado } : {})`,
 * e sem essa chave o turno é o de sempre.
 */
export async function carregarServidorMcpExterno(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<ServidorMcpExternoMontado | null> {
  const { data, error } = await supabase
    .from("organizations")
    .select("settings")
    .eq("id", organizationId)
    .maybeSingle();
  if (error) {
    logger.warn("nao foi possivel ler organizations.settings para o servidor MCP externo", {
      organization_id: organizationId,
      error: error.message,
    });
    return null;
  }

  const servidor = lerServidorMcpExterno(
    (data as { settings?: unknown } | null)?.settings,
  );
  if (!servidor) return null;

  try {
    const ferramentas = await listarFerramentasDoServidor(servidor);
    if (ferramentas.length === 0) {
      logger.warn("servidor MCP externo registrado nao anunciou nenhuma ferramenta", {
        organization_id: organizationId,
        endpoint: servidor.endpoint,
      });
      return null;
    }
    return { servidor, ferramentas };
  } catch (err) {
    logger.warn("servidor MCP externo registrado nao respondeu — turno segue sem as ferramentas dele", {
      organization_id: organizationId,
      endpoint: servidor.endpoint,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
