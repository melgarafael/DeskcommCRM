import { AmigoDomainError } from "./access";
/** A selection is valid only in the account where it was obtained. */
export function checkConnection(actual: string, expected: string | undefined, required: boolean) {
  if ((required && !expected) || (expected && expected !== actual))
    throw new AmigoDomainError(
      "amigo_connection_changed",
      409,
      "A conexão Amigo mudou. Atualize os dados e selecione novamente o paciente e a consulta.",
    );
}
