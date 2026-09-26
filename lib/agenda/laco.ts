/**
 * O laço de retorno do agendamento — invariante 7 do Sistema Vivo.
 *
 * Marcar um horário não é escrever uma linha: é um fato que precisa VOLTAR ao
 * sistema. São dois emissores, e eles respondem perguntas diferentes:
 *
 *   `crm_lead_activities` → o HUMANO vê na timeline do lead o que a IA marcou
 *   `event_log`           → o WORKER leva o compromisso para o Google
 *
 * Um sem o outro deixa metade do laço aberto: só a atividade, e o Google nunca
 * sabe; só o evento, e a equipe não vê o que foi marcado.
 *
 * Este arquivo decide O QUE emitir. Quem grava é a rota, e a separação é
 * proposital: emitir o TIPO ERRADO é o erro silencioso desta feature — a linha
 * existe, a timeline mostra uma frase, e ninguém nota que a frase está errada.
 * Decisão que se pode testar sem banco tem que ficar onde se testa sem banco.
 */
import type { AtividadeDaAgenda } from "./tipos";

/** O que o compromisso era antes; `null` quando ele está nascendo. */
export type SituacaoAnterior = "pending" | "confirmed" | null;

/**
 * Para onde ele foi. `rescheduled` não é situação no banco — é a TRANSIÇÃO de
 * remarcar, que no banco continua `confirmed` com outro horário. Ela existe
 * aqui porque a timeline precisa distinguir "marcou" de "mudou de ideia".
 */
export type Transicao =
  | "pending"
  | "confirmed"
  | "rescheduled"
  | "cancelled"
  | "completed"
  | "no_show";

/**
 * A atividade que a transição emite, ou `null` quando ela não é fato de linha
 * do tempo.
 *
 * ⚠️ NEM TODA MUDANÇA VIRA LINHA. Confirmar um pendente é operação interna — o
 * compromisso já entrou na timeline quando foi pedido — e um PATCH que só mexeu
 * em observação não mudou nada que o lead precise saber. Timeline com ruído é
 * timeline que ninguém lê, e aí o invariante 3 (log visível) morre por excesso
 * em vez de por falta.
 */
export function atividadeDaTransicao(
  de: SituacaoAnterior,
  para: Transicao,
): AtividadeDaAgenda | null {
  if (de === null) {
    // Nascer pendente ou confirmado é a MESMA notícia para quem lê: foi
    // marcado. A distinção é de operação, não de história.
    return para === "pending" || para === "confirmed" ? "appointment_scheduled" : null;
  }

  switch (para) {
    case "rescheduled":
      return "appointment_rescheduled";
    case "cancelled":
      return "appointment_cancelled";
    case "completed":
      return "appointment_completed";
    case "no_show":
      return "appointment_no_show";
    default:
      // `pending → confirmed` e qualquer transição para o mesmo estado.
      return null;
  }
}

/**
 * O gatilho de automação que a transição emite, ou `null` quando ela não é
 * notícia para uma regra.
 *
 * Existe porque o motor de regras (`lib/automation/engine.ts`) é forte —
 * condições, runs, auditoria, e a ação de mandar WhatsApp já pronta — e não
 * enxergava a agenda: nenhum dos seus gatilhos vinha de um compromisso. Um
 * estúdio que quisesse avisar "amanhã é seu horário" tinha o motor, tinha o
 * envio, e não tinha o fato.
 *
 * ⚠️ NÃO É A MESMA RÉGUA DA TIMELINE, e a diferença é o ponto:
 * `atividadeDaTransicao` devolve `null` em `pending → confirmed` porque a
 * história do lead já contou "foi marcado". Para uma regra, confirmar é
 * EXATAMENTE o momento que interessa — é quando o horário deixa de ser pedido e
 * vira compromisso, e é o gancho de "mandar a confirmação para a cliente".
 * Reaproveitar a função da timeline aqui apagaria o gatilho mais útil dos três.
 *
 * `completed` e `no_show` (#1612) saem AQUI, da TRANSIÇÃO — e não de
 * `appointment.outcome_confirmed`, que continua existindo e continua sendo
 * consumido só pelo acompanhamento de presença
 * (`lib/followup/gatilho-presenca.handler.ts`).
 *
 * Medido em `fn_appointment_change` (baseline): o RPC emite
 * `appointment.outcome_confirmed` SOMENTE quando `a.status='no_show'` — nunca
 * para `completed`. Tomar aquele evento como fonte dos dois gatilhos novos
 * deixaria `appointment.completed` para sempre mudo: o comparecimento
 * registrado pela tela e pela tool `crm_set_appointment_outcome` não teria
 * aviso nenhum, e é justamente o caso de "coloque na agenda do outro sistema".
 *
 * Dois eventos para o mesmo fato só fariam a regra rodar duas vezes se uma
 * regra pudesse assinar OS DOIS — e ela não pode: um gatilho por evento. O que
 * muda é o consumidor de cada um, e ele é diferente de propósito
 * (seguimento de presença × regra do estúdio).
 */
export function gatilhoDaTransicao(de: SituacaoAnterior, para: Transicao): string | null {
  if (de === null) {
    return para === "pending" || para === "confirmed" ? "appointment.created" : null;
  }

  switch (para) {
    case "confirmed":
      // Só sobe quando VEIO de pendente: `atualizarAgendamento` só chama com
      // transição quando o status mudou de fato.
      return de === "pending" ? "appointment.confirmed" : null;
    case "rescheduled":
      return "appointment.rescheduled";
    case "cancelled":
      return "appointment.cancelled";
    // O desfecho nasce da TRANSIÇÃO, que só existe quando o status MUDOU de
    // fato. O guard de "uma vez cada" (#1612) é do handler
    // (`input.status !== atual.status` em `atualizarAgendamento`), NÃO do tipo:
    // lá `atual.status` entra por cast em `SituacaoAnterior`, então uma
    // correção `completed → no_show` chega aqui e emite `appointment.no_show`
    // — uma vez por transição real, que é o comportamento certo.
    case "completed":
      return "appointment.completed";
    case "no_show":
      return "appointment.no_show";
    default:
      return null;
  }
}

/**
 * O compromisso precisa ser empurrado para o Google?
 *
 * ⚠️ `completed` e `no_show` NÃO empurram. O evento lá fora já aconteceu;
 * registrar aqui que a pessoa compareceu não muda nada no calendário dela.
 * Empurrar geraria escrita externa sem efeito — e escrita externa é a coisa mais
 * cara e mais arriscada que esta feature faz, então ela só acontece quando muda
 * o que o outro lado enxerga.
 */
export function precisaEmpurrarAoGoogle(de: SituacaoAnterior, para: Transicao): boolean {
  if (de === null) return para === "pending" || para === "confirmed";
  return para === "rescheduled" || para === "cancelled";
}

/**
 * O autor do agendamento traduzido para o vocabulário da TIMELINE.
 *
 * ⚠️ AS DUAS LISTAS SE PARECEM E DIVERGEM NA PONTA — medido:
 *
 *   `AUTORES_DO_AGENDAMENTO` (lib/agenda/tipos.ts)  user · ai · system · contact · sync
 *   `crm_lead_activities.actor_kind` CHECK           user · ai · system · rule · contact
 *
 * Divergem nos DOIS sentidos: `sync` só existe na agenda, `rule` só existe no
 * CHECK. Gravar `sync` na timeline é rejeitado pelo Postgres com 23514 — em
 * RUNTIME, dentro de caminho fire-and-forget, sem passar por typecheck, lint,
 * test:unit nem CI. O sintoma seria a atividade não nascendo, em silêncio.
 *
 * A escolha é mapear em vez de estender o CHECK, e a razão é de significado:
 * quem sincronizou não é uma pessoa nem a IA — é o próprio produto trazendo um
 * fato de fora, que é exatamente o que `system` já quer dizer na timeline. A
 * origem específica não se perde: ela continua em
 * `calendar_appointments.created_by_kind`, cujo CHECK tem `sync` de propósito.
 *
 * Estender o CHECK custaria migration + apêndice no baseline + MANIFEST para
 * distinguir, na tela, "o sistema registrou" de "o sistema registrou vindo do
 * Google" — distinção que nenhuma tela pede hoje.
 */
export function autorParaTimeline(autor: string): "user" | "ai" | "system" | "contact" {
  if (autor === "user" || autor === "ai" || autor === "contact") return autor;
  // `sync` e `system` caem aqui, e qualquer valor novo também: o desfecho
  // seguro é a atividade NASCER como do sistema, nunca ser rejeitada em runtime.
  return "system";
}
