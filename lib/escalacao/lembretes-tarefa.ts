import type { SupabaseClient } from "@supabase/supabase-js";

export const PATAMARES_DE_TAREFA = [3, 6, 9] as const;
export const LIMITE_DE_PATAMARES_DE_TAREFA = 10;
export const MINUTO_MAXIMO_DE_TAREFA = 1440;

/**
 * Resolve a cadência salva sem confiar em dados vindos do banco.
 * Campo ausente preserva o contrato antigo; valor inválido falha fechado.
 */
export function normalizaPatamaresDeTarefa(valor: unknown): number[] {
  if (valor === undefined || valor === null) return [...PATAMARES_DE_TAREFA];
  if (!Array.isArray(valor) || valor.length < 1 || valor.length > LIMITE_DE_PATAMARES_DE_TAREFA)
    return [];
  const patamares = valor as unknown[];
  for (let indice = 0; indice < patamares.length; indice += 1) {
    const minuto = patamares[indice];
    if (
      typeof minuto !== "number" ||
      !Number.isInteger(minuto) ||
      minuto < 1 ||
      minuto > MINUTO_MAXIMO_DE_TAREFA ||
      (indice > 0 && minuto <= (patamares[indice - 1] as number))
    ) {
      return [];
    }
  }
  return patamares as number[];
}

/** Tempo absoluto da espera. Reiniciar o processo não acumula três cobranças. */
export function patamarDaEspera(
  inicio: string,
  agora: Date,
  patamares: readonly number[] = PATAMARES_DE_TAREFA,
): number | null {
  const minutos = (agora.getTime() - Date.parse(inicio)) / 60_000;
  if (!Number.isFinite(minutos) || minutos < 0 || patamares.length === 0) return null;
  let atual: number | null = null;
  for (const patamar of patamares) {
    if (minutos < patamar) break;
    atual = patamar;
  }
  return atual;
}

/** O banco trava o caso, reavalia a espera e grava recibo + Central juntos. */
export async function processarLembretesTarefa(admin: SupabaseClient): Promise<number> {
  const { data, error } = await admin.rpc("fn_processar_lembretes_tarefa", { p_limite: 200 });
  if (error) throw new Error(error.message);
  if (typeof data !== "number") throw new Error("Resultado inválido do relógio de tarefas.");
  return data;
}
