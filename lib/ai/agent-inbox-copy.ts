/**
 * Tradução leiga (pt-br) dos itens da inbox do runtime do agente (Operação
 * Visível F1). `kind` é contrato do engine (agent_inbox_items.kind, migration
 * 0050) — a central de avisos mostra o que aconteceu sem jargão.
 */

import type { InboxKind } from "@/lib/agent-engine/db/repository";

export type AgentInboxSeverity = "info" | "warn" | "critical";

/**
 * `satisfies Record<InboxKind, string>` é o que faz o compilador cobrar: kind
 * novo no tipo sem rótulo aqui = erro de build. Antes isto era
 * `Record<string, string>`, que aceita qualquer chave e **não exige nenhuma** —
 * uma anotação que parecia tipagem e era o oposto dela. Foi assim que
 * `next_action_ambiguous` chegou à tela caindo no genérico "Aviso do
 * assistente": o item existia para pedir uma escolha e se anunciava sem dizer
 * de quê.
 */
export const KIND_LABEL = {
  qr_rescan: "Conexão do WhatsApp caiu — precisa escanear o QR de novo",
  job_dead: "Uma tarefa do assistente falhou e parou de tentar",
  event_dead: "Um evento recebido não pôde ser processado",
  budget_exceeded: "O orçamento de IA foi atingido",
  handoff: "O assistente passou um atendimento para um humano",
  promotion_review: "Proposta de melhoria do assistente aguardando sua revisão",
  judge_unaligned: "O avaliador de qualidade precisa de recalibragem",
  followup_dead: "Um fluxo de follow-up parou de tentar",
  snooze_expired: "O lead não respondeu no prazo que você definiu",
  next_action_ambiguous: "Próxima ação sem negócio definido — precisa da sua escolha",
  risk_backlog_seeded: "Negócios que já estavam parados — precisam de uma decisão",
  reactivation_expired: "A sugestão de retomar contato venceu — decida",
  // Diz o que ACONTECEU com o cliente, não o que falhou por dentro: o dono do
  // negócio precisa saber que um atendimento saiu capado, não que um token
  // colidiu. O motivo técnico fica no corpo do aviso, para quem for investigar.
  capabilities_missing: "Um atendimento saiu sem as ferramentas que você ligou",
  // Diz o que o CLIENTE viu, não o que o worker registrou: uma resposta que
  // ficou "enviando" para sempre é, do lado de lá, uma mensagem que nunca
  // chegou. O motivo técnico fica no corpo do aviso.
  message_send_stuck: "Uma resposta ficou presa e não chegou ao cliente",
  midia_nao_lida: "O agente não conseguiu ler uma foto ou áudio que o cliente enviou",
  // Diz o que o CLIENTE está esperando, não o que o sistema deixou de gravar.
  // "Promessa não cumprida" é a única frase que faz o dono do negócio agir: do
  // lado de lá existe uma pessoa que ouviu um compromisso e está aguardando.
  // O que a PLATAFORMA decidiu, não o assistente. O texto diz o que mudou e
  // por que importa agora — quem lê a Central quer saber se pode trabalhar, não
  // qual evento chegou.
  channel_template_review: "Um modelo de mensagem mudou de situação na revisão",
  channel_number_alert: "Seu número de WhatsApp precisa de atenção",
  // "ninguém cumpriu" é um veredito que NENHUMA linha de código apura — o
  // sistema não sabe se a promessa foi cumprida, e agendar um retorno não é
  // cumprir. "ninguém ficou responsável" é exatamente o que `apuraDonoDaPromessa`
  // mede: houve ferramenta neste turno? há retorno vivo? Se não, ninguém assumiu.
  promise_unfulfilled: "O assistente prometeu algo a um cliente e ninguém ficou responsável",
  contact_proposal_expired:
    "Uma informação que o assistente ouviu de um cliente venceu sem ninguém conferir",
  // Diz o que ACONTECEU, e nunca que algo parou — contraste deliberado com
  // `budget_exceeded` ("foi atingido"). Quem lê este aviso ainda tem a IA
  // respondendo; confundir os dois faria o dono do negócio correr atrás de uma
  // parada que não houve, ou ignorar a que houve.
  budget_warning: "O gasto de IA passou do aviso que você definiu",
  // Diz o que falta SABER, não o que faltou fazer: ninguém sabe ainda se o
  // cliente veio, faltou ou cancelou — o sistema não decide isso sozinho.
  appointment_outcome_pending: "Confirme o desfecho de um agendamento que já passou",
  other: "Aviso do assistente",
} as const satisfies Record<InboxKind, string>;

export const SEVERITY_LABEL: Record<AgentInboxSeverity, string> = {
  info: "informativo",
  warn: "atenção",
  critical: "crítico",
};

/**
 * O parâmetro segue `string` (não `InboxKind`) de propósito: o kind chega do
 * banco em runtime, e um clone com engine mais novo pode trazer um valor que
 * este build não conhece. O genérico é a defesa para ESSE caso — não para
 * cobrir esquecimento, que agora o compilador pega acima.
 */
export function kindLabel(kind: string): string {
  return (KIND_LABEL as Record<string, string>)[kind] ?? "Aviso do assistente";
}

/** Por que ninguém ficou responsável — o que muda é a AÇÃO que cabe a quem lê. */
export type PromessaSemDono =
  | "operador_sem_ferramentas"
  | "operador_nao_agiu"
  | "operador_nao_rodou";

/**
 * O texto do aviso de promessa sem responsável.
 *
 * ═══ A REGRA DE ESCRITA, E POR QUE ELA É ESTREITA ═══
 *
 * Nenhuma frase daqui afirma que a promessa foi ou não foi CUMPRIDA. O sistema
 * não sabe: agendar um retorno não é cumprir, e mandar uma mensagem depois
 * também não. O que ele apura é se **alguém ficou responsável**, e é só isso que
 * o texto pode dizer. A versão anterior afirmava "o sistema ainda não registrou
 * o cumprimento" — um veredito que nenhuma linha de código tinha apurado, no
 * único item que esta feature mostra ao dono do negócio.
 *
 * As três variantes dizem o MESMO fato e mudam só a ação: sem capacidade
 * marcada, o caminho é a tela do assistente; com capacidade e sem ação, é
 * decidir sobre este cliente. Um texto único mandaria metade das pessoas para o
 * lugar errado.
 */
export function copyDaPromessaSemDono(
  quantas: number,
  porque: PromessaSemDono,
): { title: string; body: string } {
  const title =
    quantas === 1
      ? "O assistente prometeu algo ao cliente e ninguém ficou responsável"
      : `${quantas} promessas ao cliente sem ninguém responsável`;

  const CORPO: Record<PromessaSemDono, string> = {
    operador_sem_ferramentas:
      "Nesta conversa o assistente combinou algo com o cliente. Ele ainda não tem nenhuma " +
      "capacidade marcada para registrar isso no sistema, então nada foi agendado nem anotado. " +
      "Abra a conversa para ver o que foi combinado — e, na tela do assistente, marque o que ele " +
      "pode fazer.",
    operador_nao_agiu:
      "Nesta conversa o assistente combinou algo com o cliente e não registrou nenhum próximo " +
      "passo para isso — não há retorno agendado. Abra a conversa, veja o que foi combinado e " +
      "decida quem faz.",
    operador_nao_rodou:
      "Nesta conversa o assistente combinou algo com o cliente, e a parte que organiza o sistema " +
      "não rodou neste atendimento. Nada foi agendado. Abra a conversa para ver o que foi " +
      "combinado e decida quem faz.",
  };

  return { title, body: CORPO[porque] };
}
