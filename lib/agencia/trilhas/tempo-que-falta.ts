/**
 * O reloginho da trilha (docs/agencia/plano-ajustes-2026-10-27.md, item 2): quanto
 * falta para o prazo de um passo, em texto curto, e em que faixa ele está. Puro —
 * a tela recalcula a cada segundo.
 */

export type NivelDoPrazo = "folga" | "perto" | "atrasado";

/** Menos que isto para o prazo é "perto" (amarelo). */
export const JANELA_DE_ALERTA_MS = 24 * 60 * 60_000;

function partes(ms: number): string {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const seg = s % 60;
  if (d > 0) return `${d} d ${h} h`;
  // Menos de um dia: com segundos, para o reloginho andar à vista.
  if (h > 0) return `${h} h ${String(m).padStart(2, "0")} min ${String(seg).padStart(2, "0")} s`;
  if (m > 0) return `${m} min ${String(seg).padStart(2, "0")} s`;
  return `${seg} s`;
}

export function tempoQueFalta(prazoIso: string, agora: Date): { texto: string; nivel: NivelDoPrazo } {
  const falta = new Date(prazoIso).getTime() - agora.getTime();
  if (falta <= 0) return { texto: `atrasado há ${partes(-falta)}`, nivel: "atrasado" };
  return { texto: `faltam ${partes(falta)}`, nivel: falta < JANELA_DE_ALERTA_MS ? "perto" : "folga" };
}
