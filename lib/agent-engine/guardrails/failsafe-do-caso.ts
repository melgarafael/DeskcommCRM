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
 *   1. **Sinal de pessoa vindo do CLIENTE** — em QUALQUER mensagem dele na
 *      demanda atual. O fail-safe é fail-safe, não filtro de qualidade: uma
 *      mensagem com sinal de pessoa basta (decisão do Marcos no #3816). A régua
 *      começou estreita — só `detectHumanHandoffRequest` — e a medição do
 *      mantenedor mostrou o custo: dos 24 pedidos coloquiais dele, só 2 casavam.
 *      "preciso de um humano", "quero falar com o gerente", "atendente", "pessoa
 *      real" e "vou no procon se ninguém me atender" ficavam de fora, e os dois
 *      erros não custam o mesmo: um aviso de passagem a mais incomoda, mas quem
 *      pediu uma pessoa com palavras comuns e não chega a ninguém é o erro mais
 *      caro. Por isso `SINAL_DE_PESSOA` é o vocabulário NOMINAL de
 *      pessoa/retaguarda (mais os termos jurídicos que a issue mediu), e não uma
 *      régua de verbo: "atendente" sozinho já é pedido;
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
 * O vocabulário NOMINAL de pessoa/retaguarda, do lado de quem ESCREVE (o
 * cliente). Cargos, coletivos e os termos jurídicos que a issue mediu — "vou no
 * procon se ninguém me atender" é pedido de gente mesmo sem verbo de contato.
 * Acentuação e caixa não importam: o texto é normalizado antes de casar.
 */
const SINAL_DE_PESSOA =
  /\b(?:humano|humana|humanos|humanas|pessoa|pessoas|gente|alguem|ninguem|atendente|atendentes|gerente|gerentes|supervisor|supervisora|responsavel|responsaveis|setor|setores|departamento|equipe|equipes|time|times|consultor|consultora|vendedor|vendedora|representante|representantes|especialista|especialistas|operador|operadora|chefe|dono|dona|procon|advogado|advogada)\b/;

/** Minúsculas + sem diacríticos (NFD), como os demais detetores determinísticos. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "");
}

/**
 * True quando a mensagem do CLIENTE tem sinal de pessoa: pedido explícito de
 * atendimento humano (`detectHumanHandoffRequest`, a régua do handoff G1) ou
 * qualquer nome de pessoa/retaguarda. Resposta curta de sim/não não casa — não
 * tem alvo humano nenhum.
 *
 * Só faz sentido sobre mensagem `inbound`; quem filtra a direção é quem chama.
 */
export function temSinalDePessoaNaMensagem(mensagem: string): boolean {
  if (mensagem.trim() === "") return false;
  if (detectHumanHandoffRequest(mensagem)) return true;
  return SINAL_DE_PESSOA.test(normalize(mensagem));
}

/**
 * True quando o fail-safe PODE abrir caso humano. Fora das duas réguas, ele
 * devolve o erro-de-ensino e deixa o modelo reformular.
 */
export function deveAbrirCasoDoFailsafe(entrada: EntradaDoFailsafeDoCaso): boolean {
  const pedidoDoCliente = entrada.mensagens.some(
    (m) => m.direction === "inbound" && temSinalDePessoaNaMensagem(m.body),
  );
  if (pedidoDoCliente) return true;
  return detectHumanHandoffPromise(entrada.corpo, entrada.alvosExtras);
}
