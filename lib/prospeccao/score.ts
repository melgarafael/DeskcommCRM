/**
 * O SCORE — heurística documentada, não ML (§19 do plano).
 *
 * "Probabilidade de recompra" sem modelo seria número inventado com cara de
 * ciência. O que o score diz de verdade: "vale o esforço comercial?" —
 * telefone (contatável), site (estabelecido), nota e volume de avaliações
 * (movimento) e categoria quente para a operação (configurável depois).
 * Pesos somam 100 e vivem aqui, num lugar só.
 */

export interface EntradaScore {
  temTelefone: boolean;
  temWebsite: boolean;
  whatsappPotencial: boolean;
  nota: number | null;
  totalAvaliacoes: number;
  /** Bônus opcional da operação (ex.: categoria alvo da campanha). */
  bonusCategoria?: number;
}

export const PESOS_SCORE = {
  telefone: 25,
  website: 15,
  whatsapp: 10,
  nota: 20,
  avaliacoes: 20,
  categoria: 10,
} as const;

export function scoreDeProspect(e: EntradaScore): number {
  let score = 0;
  if (e.temTelefone) score += PESOS_SCORE.telefone;
  if (e.temWebsite) score += PESOS_SCORE.website;
  if (e.whatsappPotencial) score += PESOS_SCORE.whatsapp;
  if (e.nota !== null) score += Math.round(PESOS_SCORE.nota * Math.min(1, e.nota / 5));
  score += Math.round(PESOS_SCORE.avaliacoes * Math.min(1, e.totalAvaliacoes / 500));
  score += Math.min(PESOS_SCORE.categoria, Math.max(0, e.bonusCategoria ?? 0));
  return Math.min(100, score);
}
