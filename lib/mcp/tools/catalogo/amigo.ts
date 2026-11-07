/** Metadados client-safe; os handlers e as decisões de acesso vivem no servidor. */
import { declararTools } from "./tipos";
import type { ToolBundle } from "../pacotes";

const leituras = [
  ["patient_search", "Buscar pacientes do responsável no Amigo", "Mostra os pacientes do responsável para escolher explicitamente quem receberá o atendimento.", "reter"],
  ["patient_get", "Ver o paciente escolhido no Amigo", "Mostra os dados do paciente escolhido e vinculado ao responsável desta conversa.", "reter"],
  ["patient_doctors", "Ver os médicos do paciente no Amigo", "Consulta o histórico de médicos do paciente escolhido para ajudar na continuidade do cuidado.", "reter"],
  ["patient_attendances", "Ver as consultas do paciente no Amigo", "Mostra as consultas do paciente escolhido, dentro do vínculo com o responsável desta conversa.", "reter"],
  ["patient_birthdays", "Consultar aniversariantes no Amigo", "Permite à gestão consultar os aniversariantes de hoje ou amanhã, sem liberar essa lista ao atendimento automático.", "reter"],
  ["attendances", "Consultar a agenda geral do Amigo", "Permite à gestão consultar atendimentos por período, sem expor a agenda geral ao atendimento automático.", "reter"],
  ["insurances", "Consultar grupos de convênios no Amigo", "Mostra grupos de convênios disponíveis para ajudar a escolher a cobertura do atendimento.", "organizar"],
  ["insurance_plans", "Consultar convênios no Amigo", "Mostra os convênios do grupo escolhido, respeitando unidade, médico e tipo de atendimento.", "organizar"],
  ["insurance_products", "Consultar produtos do convênio no Amigo", "Mostra os produtos do convênio escolhido para preservar a cobertura correta do atendimento.", "organizar"],
  ["doctors", "Consultar médicos no Amigo", "Mostra os médicos cadastrados na clínica para orientar a escolha do profissional.", "atender"],
  ["doctors_available", "Consultar médicos disponíveis no Amigo", "Mostra médicos disponíveis para a unidade, atendimento e cobertura escolhidos pela pessoa.", "atender"],
  ["specialties", "Consultar especialidades no Amigo", "Mostra especialidades disponíveis conforme a unidade e o convênio escolhidos pela pessoa.", "atender"],
  ["doctor_dates", "Consultar datas do médico no Amigo", "Consulta as datas e vagas reais do médico para o paciente escolhido, preservando o turno de atendimento.", "atender"],
  ["places", "Consultar unidades no Amigo", "Mostra as unidades da clínica para escolher onde o atendimento será realizado.", "organizar"],
  ["events", "Consultar tipos de atendimento no Amigo", "Mostra os tipos de atendimento disponíveis conforme unidade, médico e convênio escolhidos.", "organizar"],
  ["calendar", "Consultar horários do paciente no Amigo", "Consulta horários reais para o paciente escolhido, respeitando unidade, atendimento e convênio.", "atender"],
] as const;
const escritas = [
  ["patient_create", "Cadastrar paciente no Amigo", "Cadastra um paciente após escolha explícita, usando o contato responsável verificado nesta conversa."],
  ["patient_update", "Atualizar paciente no Amigo", "Atualiza os dados do paciente escolhido e vinculado ao contato responsável desta conversa."],
  ["link_patient", "Vincular paciente ao responsável no Amigo", "Vincula o paciente explicitamente escolhido ao responsável e, quando indicado, ao negócio correto."],
  ["attendance_create", "Marcar consulta no Amigo", "Marca uma vaga real para o paciente escolhido e só informa sucesso com confirmação e comprovante local."],
  ["attendance_cancel", "Cancelar consulta no Amigo", "Cancela a consulta do paciente escolhido no sistema da clínica, preservando seu histórico."],
  ["attendance_status", "Confirmar presença ou registrar chegada no Amigo", "Confirma a intenção de comparecer; a chegada é registrada apenas por uma pessoa autorizada."],
  ["attendance_reschedule", "Remarcar consulta no Amigo", "Muda a data da mesma consulta do paciente escolhido e exige conferência humana se o resultado ficar incerto."],
] as const;

export const TOOLS_AMIGO = declararTools([
  ...leituras.map(([operation, rotulo, explicacao, pacote]) => ({
    name: `crm_amigo_${operation}`, category: "read" as const, rotulo, explicacao,
    oQueToca: "Atendimento no Amigo", risco: "seguro" as const, pacotes: [pacote] as readonly ToolBundle[],
    ...(["patient_birthdays", "attendances"].includes(operation) ? { apenasHumano: true } : {}),
  })),
  ...escritas.map(([operation, rotulo, explicacao]) => ({
    name: `crm_amigo_${operation}`, category: "write" as const, rotulo, explicacao,
    oQueToca: "Atendimento no Amigo", risco: "critico" as const, pacotes: ["reter"] as readonly ToolBundle[],
  })),
]);
