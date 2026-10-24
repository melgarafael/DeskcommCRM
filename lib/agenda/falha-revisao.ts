/** Metadados técnicos do servidor; nunca são uma aprovação nem uma afirmação do cliente. */
export type FalhaDaRevisaoDeAgenda = "contexto_incompleto" | "sinal_invalido" | "candidata_desvinculada";
export const CODIGO_FALHA_REVISAO_AGENDA: Record<FalhaDaRevisaoDeAgenda, string> = {
  contexto_incompleto: "agenda_review_context_incomplete",
  sinal_invalido: "agenda_review_inconclusive",
  candidata_desvinculada: "agenda_review_candidate_misbound",
};
export function falhaTecnicaDaRevisaoDeAgenda(code?: string | null): boolean {
  return Object.values(CODIGO_FALHA_REVISAO_AGENDA).includes(code ?? "");
}
