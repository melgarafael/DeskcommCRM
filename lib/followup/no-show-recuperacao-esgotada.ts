/**
 * O laço de retorno do no-show quando a recuperação NÃO deu certo.
 *
 * `fn_appointment_recover` (migration 0224) matricula o contato num fluxo de
 * `appointment_no_show` com o `appointment_id` fixado no enrollment. Se a régua
 * chega ao fim e o cliente nunca respondeu, o enrollment conclui com outcome
 * `exhausted` — e aí o card fica exatamente onde estava: o construtor de fluxo
 * não move etapa, e não há turno do agente ao fim de uma régua de texto fixo
 * para chamar `crm_move_lead_stage`.
 *
 * Sem sinal nenhum, isso é uma demanda que morreu em silêncio (invariante 4 do
 * Sistema Vivo: nenhuma demanda sem próximo passo). O sinal é um item na Central
 * de avisos, com o COMPROMISSO como referência — quem opera decide o próximo
 * passo e move o card à mão. É a decisão registrada em relatório: "Aviso na
 * Central + mover manual", em vez de uma feature de mover-etapa no construtor.
 *
 * Esta função é a REGRA (pura, testável sem banco); quem grava o item é o
 * adaptador em `engine.ts` (`abrirAvisoRecuperacaoEsgotada`), no mesmo lugar e
 * pelo mesmo motivo que `insertDeadInboxItem`.
 */
import type { EnrollmentRow, NodeResult } from "./node-handlers";

export interface AvisoRecuperacaoEsgotada {
  organization_id: string;
  appointment_id: string;
  /** A revisão do compromisso no momento da matrícula — o índice único da 0224
   *  é por (compromisso, revisão, tipo), então remarcar gera uma falta nova e
   *  um aviso novo, e reprocessar a mesma não duplica. */
  appointment_revision: number | null;
  /** Só para o log/correlação — o `ref_id` do item é o compromisso, não isto. */
  ref_enrollment_id: string;
}

/**
 * Deve abrir aviso? Só quando TODAS valem:
 *  - o passo não é replay (senão um reprocesso abre o aviso de novo — o 23505 do
 *    índice único cobre, mas nem chega lá);
 *  - o enrollment terminou de verdade (`complete`) com outcome `exhausted` —
 *    `replied` (cliente voltou, normalmente via `cancel_on_reply`) e o `custom`
 *    do ramo "fora do alvo" (outcome `null`) não avisam;
 *  - o enrollment carrega `appointment_id` — é o que distingue uma régua de
 *    recuperação de falta de qualquer outro fluxo esgotado.
 */
export function avisoDeRecuperacaoEsgotada(
  enrollment: EnrollmentRow,
  result: NodeResult,
  isReplay: boolean,
): AvisoRecuperacaoEsgotada | null {
  if (isReplay) return null;
  if (result.kind !== "complete" || result.outcome !== "exhausted") return null;
  if (!enrollment.appointment_id) return null;
  return {
    organization_id: enrollment.organization_id,
    appointment_id: enrollment.appointment_id,
    appointment_revision: enrollment.appointment_revision ?? null,
    ref_enrollment_id: enrollment.id,
  };
}
