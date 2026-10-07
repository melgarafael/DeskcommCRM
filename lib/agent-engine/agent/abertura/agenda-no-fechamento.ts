import type { ModelMessage } from "ai";

import type { Queryable } from "../../queue/queue";
import { buildCompromissosBlock } from "../compromissos-do-contato";

const FERRAMENTAS_DE_AGENDA = new Set([
  "crm_list_appointments",
  "crm_find_free_slots",
  "crm_book_appointment",
  "crm_find_and_book_appointment",
  "crm_reschedule_appointment",
  "crm_cancel_appointment",
  "crm_confirm_appointment",
  "crm_set_appointment_outcome",
]);

/** Só paga outra leitura quando a agenda participou deste turno. */
export async function agendaNoFechamento(input: {
  db: Queryable;
  organizationId: string;
  contactId: string;
  agora: Date;
  blocoDaAbertura: string;
  mensagens: readonly ModelMessage[];
}): Promise<string> {
  const usouAgenda = input.mensagens.some(
    (m) =>
      m.role === "tool" &&
      m.content.some((p) => p.type === "tool-result" && FERRAMENTAS_DE_AGENDA.has(p.toolName)),
  );
  if (!input.blocoDaAbertura && !usouAgenda) return "";

  // A abertura precede as tools: após criar/remarcar/cancelar, reutilizá-la no
  // fechamento ensinava o horário antigo ao resumo do PRÓXIMO turno.
  const atual = await buildCompromissosBlock(
    input.db,
    input.organizationId,
    input.contactId,
    input.agora,
  );
  return [
    "## Agenda verificada depois das ações deste turno",
    "Esta leitura é o estado atual das reservas deste contato. Para data, hora e situação de reserva, ela prevalece sobre o resumo anterior e o bloco da abertura. Corrija os registros que divergirem; preserve pedidos e preferências como pedidos, sem tratá-los como reservas.",
    atual ||
      "Nenhum compromisso ativo e futuro foi encontrado para este contato. Isso não informa horários livres nem apaga compromissos passados.",
  ].join("\n");
}
