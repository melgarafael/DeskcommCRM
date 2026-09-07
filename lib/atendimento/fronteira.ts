/** Identidade capturada na origem do trabalho; nunca recompor com o estado atual. */
export interface ServiceBoundary {
  organization_id: string;
  contact_id: string;
  conversation_id: string;
  service_revision: number;
  demanda_id: string | null;
  demanda_revision: number | null;
}
export interface CurrentServiceBoundary extends ServiceBoundary {
  status: string;
  demanda_fechada_em: string | null;
}
export class StaleServiceBoundaryError extends Error {
  constructor() {
    super("service_boundary_stale");
    this.name = "StaleServiceBoundaryError";
  }
}
/**
 * ABRIR A PRIMEIRA DEMANDA NÃO É ATENDIMENTO NOVO — e quem diz isso é o schema.
 *
 * A migration 0222 só incrementa `service_revision` quando TROCA de demanda
 * (`current_demanda_id is not null and current_demanda_id <> d.id`); ir de
 * "nenhuma demanda" para a primeira mantém a revisão de propósito, porque é o
 * mesmo atendimento. Comparar `demanda_id` por igualdade crua fazia o
 * TypeScript discordar do SQL sobre o que é "o mesmo atendimento".
 *
 * O custo disso não era só um teste vermelho: o gatilho de silêncio captura a
 * fronteira de um contato CALADO — que, por definição, não tem demanda aberta —
 * e o nó `ai_classify` fica em `waiting_reply` esperando o inbound do lead. Era
 * exatamente essa resposta que abria a primeira demanda e, pelo predicado
 * estrito, vencia o acompanhamento que ela acabara de acordar. O nó ficava
 * morto por construção, em produção e não só no e2e.
 *
 * O que continua vetando quando `expected.demanda_id` é nulo: a demanda fechar
 * (`current.demanda_fechada_em`), a conversa virar terminal (`status`), e
 * TROCAR de demanda ou reabrir — os dois incrementam `service_revision`. E o
 * estado sucessor admitido é exatamente UM: uma segunda demanda na mesma
 * revisão é impossível pela regra da 0222 acima.
 */
function demandaTrocou(expected: ServiceBoundary, current: CurrentServiceBoundary): boolean {
  if (expected.demanda_id === null) return false;
  return (
    expected.demanda_id !== current.demanda_id ||
    expected.demanda_revision !== current.demanda_revision
  );
}
export function assertCurrentServiceBoundary(
  expected: ServiceBoundary | null,
  current: CurrentServiceBoundary | null,
): void {
  if (
    !expected ||
    !current ||
    (expected.demanda_id !== null && !Number.isSafeInteger(expected.demanda_revision)) ||
    (current.demanda_id !== null && !Number.isSafeInteger(current.demanda_revision)) ||
    ["closed", "resolved", "archived"].includes(current.status) ||
    current.demanda_fechada_em ||
    expected.organization_id !== current.organization_id ||
    expected.contact_id !== current.contact_id ||
    expected.conversation_id !== current.conversation_id ||
    expected.service_revision !== current.service_revision ||
    demandaTrocou(expected, current)
  ) {
    throw new StaleServiceBoundaryError();
  }
}
export function parseServiceBoundary(value: unknown): ServiceBoundary | null {
  if (!value || typeof value !== "object") return null;
  const b = value as Record<string, unknown>;
  if (
    typeof b.organization_id !== "string" ||
    typeof b.contact_id !== "string" ||
    typeof b.conversation_id !== "string" ||
    !Number.isSafeInteger(b.service_revision) ||
    Number(b.service_revision) < 1 ||
    !(b.demanda_id === null || typeof b.demanda_id === "string") ||
    !(b.demanda_revision === null || Number.isSafeInteger(b.demanda_revision))
  )
    return null;
  return b as unknown as ServiceBoundary;
}
