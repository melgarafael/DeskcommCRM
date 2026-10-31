/**
 * A RÉGUA DO FAIL-SAFE DE CASO HUMANO (issue #3725).
 *
 * ## O que decide
 *
 * Quando o `casePromiseGate` veta duas vezes a mesma promessa, o fail-safe do
 * turno (`inbound-turn.ts`) ABRE UM CASO HUMANO: a conversa vai para a fila e o
 * cliente recebe o aviso de passagem. Isso é caro e é uma AFIRMAÇÃO ao cliente
 * ("passei seu pedido para um atendente") — e a afirmação só é verdadeira se
 * alguém de fato tiver pedido um humano.
 *
 * O defeito medido: o cliente respondeu SÓ "Não" a "tem algum dia ou período
 * melhor para o contato?"; a IA respondeu "sem problema, nossa equipe te
 * responde outro dia" — promessa de RETOMADA — e o caso humano foi aberto. O
 * cliente leu "passei seu pedido para um atendente humano" sem ter pedido
 * atendente nenhum.
 *
 * ## As duas réguas, em OU
 *
 *   1. **Pedido explícito do cliente** — `detectHumanHandoffRequest`, o mesmo
 *      detector determinístico do handoff G1 ("falar com um atendente", "me
 *      passa para uma pessoa", "atendimento humano"). Resposta curta de sim/não
 *      NÃO casa: não tem verbo de contato nem alvo humano;
 *   2. **Promessa explícita de envolver alguém AGORA** —
 *      `detectHumanHandoffPromise` (família da AÇÃO do `human-promise.ts`). A
 *      família do RETORNO ("a equipe vai te responder", "assim que liberarem")
 *      fica de fora de propósito: é promessa de voltar a falar, e o destino
 *      dela é `schedule_followup`, não a fila humana.
 *
 * Sem nenhuma das duas, quem chama NÃO abre caso: o veto continua de pé (a
 * promessa não sai para o cliente) e o modelo recebe o erro-de-ensino para
 * reformular. O que não acontece é a passagem inventada.
 *
 * ## Por que a decisão mora aqui, e não dentro do turno
 *
 * Porque é uma regra de PRODUTO com duas fontes de sinal, e o turno é o pior
 * lugar do repo para testá-la (closure de 6 mil linhas, job, pool, canal). Aqui
 * é função pura: entra conversa + candidata, sai "abre" ou "não abre".
 */
import { detectHumanHandoffRequest } from "../agent/human-handoff";

import { detectHumanHandoffPromise } from "./human-promise";

/** O que a régua lê de cada mensagem da conversa — estrutural, sem o tipo do turno. */
export interface MensagemDaConversaParaFailsafe {
  direction: string;
  body: string;
}

export interface EntradaDoFailsafeDoCaso {
  /** Últimas mensagens da conversa, na ordem (mais antiga primeiro). */
  mensagens: readonly MensagemDaConversaParaFailsafe[];
  /** A candidata a envio que o gate barrou. */
  corpo: string;
  /** `ai_agent_versions.handoff_keywords` — alvo humano próprio do tenant. */
  alvosExtras?: readonly string[];
}

/**
 * True quando o fail-safe PODE abrir caso humano. Fora das duas réguas, ele
 * devolve o erro-de-ensino e deixa o modelo reformular.
 */
export function deveAbrirCasoDoFailsafe(entrada: EntradaDoFailsafeDoCaso): boolean {
  const pedidoDoCliente = entrada.mensagens.some(
    (m) => m.direction === "inbound" && detectHumanHandoffRequest(m.body),
  );
  if (pedidoDoCliente) return true;
  return detectHumanHandoffPromise(entrada.corpo, entrada.alvosExtras);
}
