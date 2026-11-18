/**
 * O DESFECHO DO COMPROMISSO E QUEM PODE REGISTRÁ-LO (issue #4515).
 *
 * `completed` e `no_show` respondem "o que aconteceu?" — e a resposta sempre veio
 * de uma PESSOA, na Agenda. O `actor.type !== "user"` que morava no handler
 * recusava token e agente de uma vez, de propósito: um texto interpretado por
 * modelo não registra presença, e até a #4515 nem token de integração podia.
 *
 * A #4515 abre UMA porta e só ela: o token emitido com o escopo daqui. Quem
 * emite o token decide se aquela integração marca presença — o mesmo desenho de
 * `messages:on_behalf` (#1613), em que o escopo extra da rota é concedido na
 * tela de Chaves de API e nada é liberado por omissão.
 *
 * ⚠️ O ESCOPO É O DA ESCRITA DA AGENDA, não um `mcp:write` genérico. `mcp:write`
 * é a porta larga de todas as escritas do MCP; reaproveitá-lo faria toda
 * integração que já cria lead também declarar quem faltou — sem ninguém ter
 * concedido isso. O nome segue o que a issue propôs (`agenda:attendance`) e o
 * prefixo dos escopos por área já existentes (`contacts:write`, `leads:write`).
 *
 * ⚠️ O AGENTE DE IA CONTINUA FORA por omissão: o token do runtime
 * (`lib/ai/runtime/mcp_token.ts`) não nasce com este escopo, então
 * `crm_set_appointment_outcome` segue devolvendo `requer_confirmacao_humana` ao
 * modelo. Quem quiser um agente marcando presença emite um token com o escopo —
 * e assume a decisão por escrito.
 */
import type { Actor } from "@/lib/api/handlers/types";

/** O escopo que libera marcar comparecimento por token de API. */
export const ESCOPO_DO_COMPARECIMENTO = "agenda:attendance";

/**
 * A recusa de quem não tem o escopo — a MESMA frase na rota e na ferramenta.
 *
 * Ela nomeia o escopo que falta porque é isso que o dono da integração precisa
 * ler para consertar: "403 forbidden" sem o nome manda abrir chamado para
 * descobrir o que pedir. Onde conceder também vai escrito; a tela é o único
 * lugar que emite token.
 */
export const RECUSA_DO_COMPARECIMENTO =
  "Este token não tem o escopo `agenda:attendance`, que é o que libera marcar " +
  "comparecimento (Realizado / Não compareceu) pela API e pelo MCP. Peça a quem " +
  "emitiu o token para incluí-lo em Configurações › Chaves de API.";

/** O token traz o escopo de comparecimento? Escopos ausentes nunca liberam. */
export function tokenTemEscopoDoComparecimento(
  escopos: readonly string[] | undefined | null,
): boolean {
  return (escopos ?? []).includes(ESCOPO_DO_COMPARECIMENTO);
}

/**
 * Quem pode registrar o desfecho.
 *
 * - Sessão de navegador (`user`): sempre — é o caminho de antes, intacto.
 * - Token de API (`api_token`) com o escopo: sim, e só ele. O agente de IA fica
 *   de fora MESMO se algum dia ganhar o escopo: um modelo propondo "a pessoa
 *   veio" não é testemunho, e o escopo do token é uma decisão de quem o emitiu
 *   sobre o sistema que chama — não sobre o texto que o modelo interpretou.
 */
export function podeRegistrarComparecimento(
  actor: Pick<Actor, "type">,
  escopos?: readonly string[] | null,
): boolean {
  if (actor.type === "user") return true;
  return actor.type === "api_token" && tokenTemEscopoDoComparecimento(escopos);
}
