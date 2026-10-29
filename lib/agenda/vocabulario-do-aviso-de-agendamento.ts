/**
 * O VOCABULÁRIO do aviso de agendamento no WhatsApp — espelho dos CHECKs de
 * `entregas_de_aviso_de_agendamento` (migration 0753).
 *
 * Tupla `as const` e não union solta, pelo mesmo motivo do aviso de caso
 * (`lib/escalacao/vocabulario-do-aviso.ts`): o invariante
 * `tests/invariants/vocabulario-banco-x-typescript.test.ts` compara valor a
 * valor com o CHECK. Um status só no CHECK vira linha que a tela não sabe
 * rotular; só aqui vira `23514` no UPDATE que o handler faz DEPOIS do envio.
 *
 * O código de ERRO não é redeclarado: é o MESMO de
 * `ERROS_DA_ENTREGA_DE_AVISO`, porque as causas são as mesmas (o mesmo canal,
 * o mesmo transporte, o mesmo anti-ban). Duas listas para o mesmo fato
 * divergiriam no primeiro código novo.
 */

export const STATUS_DA_ENTREGA_DE_AGENDAMENTO = [
  "pendente",
  "enviado",
  "falhou",
  "cancelado",
  /**
   * Chegou entre 22h e 7h no fuso da organização: não sai aviso individual, e
   * o agendamento entra no resumo das 7h.
   */
  "para_o_resumo",
  /** Já foi contado no resumo das 7h. */
  "no_resumo",
] as const;
export type StatusDaEntregaDeAgendamento = (typeof STATUS_DA_ENTREGA_DE_AGENDAMENTO)[number];

/** O que a linha de entrega representa: um aviso de evento ou o resumo do dia. */
export const TIPOS_DA_ENTREGA_DE_AGENDAMENTO = ["aviso", "resumo"] as const;
export type TipoDaEntregaDeAgendamento = (typeof TIPOS_DA_ENTREGA_DE_AGENDAMENTO)[number];

/** Os três eventos de `lib/agenda/laco.ts` que este aviso consome. */
export const EVENTOS_DO_AVISO_DE_AGENDAMENTO = [
  "appointment.created",
  "appointment.rescheduled",
  "appointment.cancelled",
] as const;
export type EventoDoAvisoDeAgendamento = (typeof EVENTOS_DO_AVISO_DE_AGENDAMENTO)[number];

/** A frase de cada status, para a lista de entregas da tela. */
export const FRASE_DO_STATUS_DE_AGENDAMENTO = {
  pendente: "Aguardando envio",
  enviado: "Enviado",
  falhou: "Não saiu",
  cancelado: "Cancelado",
  para_o_resumo: "Vai no resumo das 7h",
  no_resumo: "Entrou no resumo das 7h",
} as const satisfies Record<StatusDaEntregaDeAgendamento, string>;
