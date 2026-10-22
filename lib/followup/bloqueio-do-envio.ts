import type { MotivoDeElegibilidade } from "@/lib/ai/elegibilidade/gate";

/**
 * Quando o portão de elegibilidade barra o texto fixo de um fluxo, o que vira
 * linha no histórico da inscrição — ou `null` quando a inscrição deve esperar.
 *
 * Antes, o bloqueio só ia para o log do servidor: o job fechava `done`, a
 * inscrição ficava parada em "envio na fila" com rechecagens de 10 em 10
 * minutos, e quem montou o fluxo não tinha como saber por quê (medido no teste,
 * out/2026: número em modo de teste com a lista vazia).
 *
 * Só os bloqueios do CANAL encerram — o contato não vai receber nada deste
 * fluxo enquanto a configuração não mudar, e encerrar libera o slot para o
 * gatilho disparar de novo depois de ajustada. Pessoa no comando (silêncio,
 * conversa de humano, `force_human`) NÃO encerra: ali vale a política de
 * handoff do fluxo, que pausa.
 */
const FRASES: Partial<Record<MotivoDeElegibilidade, string>> = {
  fora_da_lista_de_teste:
    "não enviado: o número está em modo de teste e este contato não está na lista de teste (Conexões › Configurar acesso da IA)",
  sem_autorizacao:
    "não enviado: o número só fala com contatos autorizados, e este contato não está autorizado",
  autorizacao_expirada: "não enviado: a autorização deste contato para respostas automáticas venceu",
  ai_opt_out: "não enviado: o contato pediu para não receber respostas automáticas",
};

export function motivoDeEncerramentoPorElegibilidade(motivo: MotivoDeElegibilidade): string | null {
  return FRASES[motivo] ?? null;
}
