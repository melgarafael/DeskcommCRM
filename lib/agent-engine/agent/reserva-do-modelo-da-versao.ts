import type { PublishedAgentConfig } from "@/lib/agent-engine/agent/agent-config";

/**
 * A reserva de modelo configurada na versão publicada do agente — as duas
 * colunas `ai_agent_versions.reserve_provider` / `reserve_model`.
 *
 * Par incompleto NÃO vira degrau: provedor sem modelo (e o contrário, e o
 * espaço em branco) é configuração pela metade, e cair para "o provedor que
 * estiver na mão" seria pior que não cair — o dono do agente acreditaria estar
 * protegido sem estar.
 *
 * Mora num módulo próprio, e não em `agent-config.ts`, de propósito: a cerca
 * `knobs-da-versao-publicada-sao-aplicados` cobra que todo campo carregado da
 * versão tenha consumidor FORA do mapeamento que o carrega, e a extração é o
 * consumidor de verdade — não uma anotação para a cerca passar.
 */
export function reservaDeModeloDaVersao(
  agentConfig: PublishedAgentConfig,
): { provider: string; model: string } | undefined {
  const provider = agentConfig.reserveProvider?.trim() ?? "";
  const model = agentConfig.reserveModel?.trim() ?? "";
  return provider !== "" && model !== "" ? { provider, model } : undefined;
}
