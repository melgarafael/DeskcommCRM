import { amigoOperations, type AmigoOperation } from "./contracts";
export const agentOperations = [...amigoOperations, "link_patient"] as const;
export type AgentOperation = AmigoOperation | "link_patient";
const labels: Record<AgentOperation, string> = {
  patient_search: "Buscar paciente por CPF ou telefone",
  patient_get: "Consultar cadastro do paciente",
  patient_create: "Cadastrar paciente",
  patient_update: "Atualizar cadastro do paciente",
  patient_doctors: "Consultar médicos do paciente",
  patient_birthdays: "Consultar aniversariantes",
  insurances: "Consultar grupos de convênios",
  insurance_plans: "Consultar planos de convênio",
  insurance_products: "Consultar produtos do convênio",
  doctors: "Consultar profissionais",
  doctors_available: "Consultar profissionais disponíveis",
  specialties: "Consultar especialidades",
  doctor_dates: "Consultar datas e horários disponíveis",
  attendance_create: "Agendar consulta",
  attendances: "Consultar agenda geral",
  patient_attendances: "Consultar consultas do paciente",
  attendance_cancel: "Cancelar consulta",
  attendance_status: "Confirmar consulta (chegada: somente equipe)",
  attendance_reschedule: "Remarcar consulta",
  places: "Consultar unidades",
  events: "Consultar tipos de atendimento",
  calendar: "Consultar calendário",
  link_patient: "Vincular paciente ao contato",
};
export const agentOperationOptions = agentOperations.map((id) => ({
  id,
  label: labels[id],
  humanOnly: id === "patient_birthdays" || id === "attendances",
}));
export function agentMayExecute(
  enabled: readonly string[] | null | undefined,
  operation: AgentOperation,
  selectedTools?: readonly string[],
) {
  return (
    (enabled == null || enabled.includes(operation)) &&
    (selectedTools === undefined || selectedTools.includes(`crm_amigo_${operation}`))
  );
}
