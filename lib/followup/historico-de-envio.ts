/** Eventos de observação do dossiê. Fora das leituras de controle do motor. */
export const TITULOS_DO_HISTORICO_DE_ENVIO: Readonly<Record<string, string>> = {
  followup_job_queued: "Tarefa de envio enfileirada",
  followup_message_generated: "Mensagem gerada",
  followup_draft_generated: "Rascunho de mensagem gerado para aprovação",
  followup_message_queued: "Mensagem aguardando o canal",
  followup_message_sent: "Mensagem enviada",
  followup_message_failed: "Falha ao enviar a mensagem",
  followup_send_partial: "Apenas parte da mensagem foi enviada",
};
