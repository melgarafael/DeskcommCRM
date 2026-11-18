/**
 * A régua de tokens do motor, num módulo FOLHA (sem import nenhum).
 *
 * Mora aqui, e não em `get-lead-context.ts`, para a tela poder usar a MESMA conta
 * que o turno usa: aquele módulo importa logger e tipo de fila, que não descem
 * para o navegador. `get-lead-context.ts` reexporta os dois nomes, então quem já
 * importava de lá não muda.
 *
 * Heurística conservadora de contagem: ~3,5 chars/token para pt-br (BPE real fica
 * entre 3,5 e 4; dividir por menos SUPERESTIMA tokens — erra pro lado seguro).
 */
export const CHARS_PER_TOKEN = 3.5;

export function countPayloadTokens(serialized: string): number {
  return Math.ceil(serialized.length / CHARS_PER_TOKEN);
}
