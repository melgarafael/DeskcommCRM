/**
 * Tradução leiga (pt-br) dos casos humanos (spec 15) — a superfície onde o
 * atendente vê os bloqueios que a IA não resolve sozinha e devolve a
 * resposta. Um caso NÃO é handoff: a IA segue conversando com o cliente,
 * só que espera o humano resolver um bloqueio pontual. Nunca mostrar enum
 * cru (status/kind/actor_kind/source) ao atendente — sempre via este mapa.
 */
import type { CaseEvent, CaseHumanAction, CaseStatus } from "@/hooks/ai/useCases";

/**
 * DO QUE O CASO TRATA — o vocabulário que a IA escolhe e por onde a fila se tria.
 *
 * ⚠️ ESTA CONSTANTE É A FONTE. A coluna `agent_cases.kind` é `text` **sem
 * CHECK**, pela doutrina de vocabulário aberto do CLAUDE.md: o que serve muda
 * com o nicho, e um CHECK fixo exigiria migration por negócio e quebraria o
 * `update.sh` de um clone com valor próprio. Quem prende o vocabulário é isto
 * aqui — e quem escreve usa a constante, nunca uma string literal.
 *
 * ⚠️ A LISTA É CURTA DE PROPÓSITO. Ela existe para TRIAR, não para descrever: o
 * que o caso é em detalhe já está no `title` e no `summary`, escritos pela IA
 * com as palavras daquele cliente. Vinte categorias dariam a ilusão de precisão
 * e produziriam classificação inconsistente — o modelo escolheria diferente para
 * o mesmo pedido em dias diferentes, e o filtro pioraria em vez de ajudar.
 *
 * Medido no CRM de origem (102 pedidos): agendamento 53, atendimento humano 33,
 * remarcação 4, pagamento 4, curso 3, cancelamento 2, dúvida 2, outro 1. As três
 * primeiras são a mesma pergunta ("mexer no horário de alguém") e colapsam em
 * `agendamento`; "atendimento humano" não entra porque no destino pedir uma
 * pessoa é handoff, não caso.
 */
export const TIPOS_DE_CASO = {
  agendamento: "Horário",
  duvida: "Dúvida",
  problema: "Algo deu errado",
  financeiro: "Pagamento",
  acesso: "Acesso ou cadastro",
  outro: "Outro",
} as const;

export type TipoDeCaso = keyof typeof TIPOS_DE_CASO;

/** O que a IA lê para escolher. Uma frase por tipo, sem exemplo de nicho. */
export const TIPOS_DE_CASO_PARA_A_IA: Record<TipoDeCaso, string> = {
  agendamento: "marcar, remarcar ou cancelar um horário",
  duvida: "uma pergunta que você não conseguiu responder",
  problema: "algo deu errado, uma reclamação, um atendimento insatisfatório",
  financeiro: "pagamento, cobrança, valor, reembolso",
  acesso: "liberar acesso, corrigir cadastro, senha",
  outro: "não se encaixa em nenhum dos acima",
};

/**
 * O rótulo de um tipo vindo do banco.
 *
 * Aceita `string` e não `TipoDeCaso` de propósito: o valor chega em runtime, e
 * um clone com engine mais novo (ou um caso classificado antes de alguém
 * encurtar a lista) pode trazer algo que este build não conhece. Cair no
 * genérico é o desfecho certo — vocabulário aberto sem fallback é vocabulário
 * que quebra a tela.
 */
export function tipoDeCasoLabel(kind: string): string {
  return (TIPOS_DE_CASO as Record<string, string>)[kind] ?? TIPOS_DE_CASO.outro;
}

export const STATUS_LABEL: Record<CaseStatus, string> = {
  awaiting_human: "Aguardando você",
  awaiting_lead: "Aguardando o cliente",
  resolved: "Concluído",
  escalated: "Virou atendimento humano",
  cancelled: "Cancelado",
};

export const STATUS_BADGE_VARIANT: Record<CaseStatus, "warning" | "info" | "success" | "neutral"> = {
  awaiting_human: "warning",
  awaiting_lead: "info",
  resolved: "success",
  escalated: "neutral",
  cancelled: "neutral",
};

/**
 * Por que o painel de resposta está desabilitado fora de `awaiting_human`.
 * Sem entrada para `awaiting_human` de propósito — ali o painel está ativo.
 */
export const CASE_REPLY_DISABLED_REASON: Partial<Record<CaseStatus, string>> = {
  awaiting_lead: "Aguardando o cliente responder — a IA avisa você quando tiver a informação.",
  resolved: "Este caso já foi concluído.",
  escalated: "Este caso virou atendimento humano — não precisa mais de resposta aqui.",
  cancelled: "Este caso foi cancelado.",
};

export interface CaseActionOption {
  action: CaseHumanAction;
  label: string;
  help: string;
}

/** As 3 ações do POST .../reply — rótulo + efeito em 1 linha (não é óbvio). */
export const CASE_ACTIONS: CaseActionOption[] = [
  {
    action: "resolved",
    label: "Concluí",
    help: "A IA avisa o cliente e encerra o assunto.",
  },
  {
    action: "need_lead_info",
    label: "Preciso de info do cliente",
    help: "A IA pergunta ao cliente e o caso volta pra você quando ele responder.",
  },
  {
    action: "escalate",
    label: "Não consigo — passar pra humano",
    help: "Sai da IA: a conversa vira um atendimento humano de verdade.",
  },
];

const EVENT_LABEL: Record<CaseEvent["kind"], string> = {
  opened: "A IA abriu o caso",
  human_replied: "Você respondeu",
  lead_asked: "A IA perguntou ao cliente",
  lead_provided: "O cliente respondeu",
  lead_unresponsive: "O cliente não respondeu a tempo",
  resolved: "Concluído",
  escalated: "Virou atendimento humano",
  cancelled: "Cancelado",
};

const HUMAN_ACTION_LABEL: Record<CaseHumanAction, string> = {
  resolved: "Você concluiu o caso",
  need_lead_info: "Você pediu uma informação ao cliente",
  escalate: "Você decidiu passar para atendimento humano",
};

/** Traduz um evento da timeline pra uma frase pt-br — nunca o enum cru. */
export function caseEventLabel(event: Pick<CaseEvent, "kind" | "actor_kind" | "human_action">): string {
  if (event.kind === "opened" && event.actor_kind === "system") {
    return "O sistema abriu o caso automaticamente";
  }
  if (event.kind === "human_replied" && event.human_action) {
    return HUMAN_ACTION_LABEL[event.human_action];
  }
  return EVENT_LABEL[event.kind] ?? "Atualização do caso";
}
