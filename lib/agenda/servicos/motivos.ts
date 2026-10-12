/** Vocabulário do operador, compartilhado pelo painel e pelas recusas da rota. */
export const MOTIVOS_DO_SERVICO: Readonly<Record<string, string>> = {
  service_not_found: "Serviço não encontrado.",
  service_inactive: "Este serviço não está ativo para novas reservas.",
  outside_schedule: "Fora da programação deste serviço.",
  outside_booking_window: "Fora do período permitido para reservar.",
  schedule_ambiguous: "Há horários sobrepostos na programação. Confira a configuração.",
  availability_unverified: "Disponibilidade não verificada. Confira a conexão do calendário.",
  publication_unavailable: "O calendário de destino não está disponível. Confira a conexão.",
  blocked: "Bloqueado para novas reservas. As reservas existentes permanecem.",
  capacity_reached: "A capacidade deste horário foi atingida.",
  professional_not_eligible: "Este profissional não está habilitado para o serviço.",
  professional_unavailable: "Nenhum profissional habilitado está disponível neste horário.",
  resource_unavailable: "Um recurso necessário está indisponível neste horário.",
  service_stale: "A configuração mudou. Consulte os horários novamente.",
};
