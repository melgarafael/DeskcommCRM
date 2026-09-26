/**
 * Labels pt-br congelados da aba Automações (UI-T3). Fonte única — a timeline
 * de atividade (UI-T4) importa os mesmos mapas, nunca redeclara os textos.
 */
import type { TRIGGER_EVENTS } from "@/lib/schemas/webhooks";

export type TriggerEvent = (typeof TRIGGER_EVENTS)[number];
export type ActionType =
  | "create_or_move_lead"
  | "send_whatsapp_message"
  | "send_ai_message"
  | "add_tag"
  | "assign_owner"
  | "call_webhook"
  | "start_message_flow";

export const TRIGGER_LABELS: Record<TriggerEvent, string> = {
  "lead.created": "Quando entrar um contato novo (webhook)",
  "lead.stage_changed": "Quando um lead mudar de etapa",
  "message.received": "Quando chegar mensagem no WhatsApp",
  // A frase é do ponto de vista de quem RECEBE o aviso: a falha é do envio, e
  // é ela que manda o integrador verificar. "não for entregue" cobre os dois
  // caminhos que emitem (recusa da plataforma e pré-voo), sem prometer que a
  // causa é sempre a mesma.
  "message.failed": "Quando uma mensagem não for entregue",
  "lead.tag_added": "Quando um lead ganhar uma tag",
  "contact.tag_added": "Quando um contato ganhar uma tag",
  // A frase evita "agendamento criado", que não diz ao operador o que ele vê na
  // agenda: um horário marcado pode nascer pendente (o tipo pede confirmação) ou
  // já confirmado, e os dois caem aqui.
  "appointment.created": "Quando um horário for marcado",
  "appointment.confirmed": "Quando um horário pendente for confirmado",
  "appointment.rescheduled": "Quando um horário for remarcado",
  "appointment.cancelled": "Quando um horário for cancelado",
  // O desfecho (#1612): a frase diz o que a EQUIPE registrou na tela —
  // "compareceu" e "faltou" são os botões Realizado/Faltou do histórico, e
  // usar outro vocabulário aqui faria o operador procurar o gatilho que já viu.
  "appointment.completed": "Quando alguém comparecer ao compromisso",
  "appointment.no_show": "Quando alguém faltar ao compromisso",
  "contact.birthday": "No aniversário de um contato",
  // A frase diz o que a regra vê ("uma data do funil"), e não o que o operador
  // escreveu — o campo é escolhido embaixo, e o mesmo rótulo serve para "data
  // do casamento", "vencimento" e "data da prova".
  "lead.date_field_due": "Quando faltarem N dias para uma data do funil",
};

export const ACTION_LABELS: Record<ActionType, string> = {
  create_or_move_lead: "Criar/mover lead no funil",
  send_whatsapp_message: "Enviar mensagem no WhatsApp",
  send_ai_message: "Mensagem escrita pela IA",
  add_tag: "Adicionar tag",
  assign_owner: "Atribuir a um atendente",
  call_webhook: "Avisar outro sistema (webhook)",
  start_message_flow: "Iniciar fluxo de mensagem",
};
