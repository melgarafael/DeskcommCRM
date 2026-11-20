import { roleAtLeast } from "@/lib/auth/types";

export class AmigoDomainError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export interface AmigoAccess {
  role: string;
  automated: boolean;
  contactId?: string;
}

/** Additional domain restrictions after the REST/MCP authentication guard. */
export function requireAmigoAccess(context: AmigoAccess, operation: string) {
  if (!roleAtLeast(context.role, "agent"))
    throw new AmigoDomainError(
      "forbidden",
      403,
      "Seu perfil não pode acessar os recursos do Amigo.",
    );
  const globalPatient = operation === "patient_birthdays" || operation === "attendances";
  const patientOperation = operation.startsWith("patient_") || operation.startsWith("attendance_");
  if (context.automated && globalPatient)
    throw new AmigoDomainError(
      "forbidden",
      403,
      "O atendimento automático só consulta o paciente da conversa.",
    );
  if (context.automated && patientOperation && !context.contactId)
    throw new AmigoDomainError(
      "amigo_contact_required",
      403,
      "Esta operação exige o contato verificado do atendimento.",
    );
  if (
    (globalPatient || (operation.startsWith("patient_") && !context.contactId)) &&
    !roleAtLeast(context.role, "manager")
  ) {
    throw new AmigoDomainError(
      "amigo_contact_required",
      403,
      "Abra a ficha de um contato ou peça à gestão para consultar pacientes.",
    );
  }
}
