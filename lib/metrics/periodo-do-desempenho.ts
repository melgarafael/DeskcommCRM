import { offsetEmMinutos, partesNoFuso } from "@/lib/agenda/fuso";

export const MAXIMO_DE_DIAS = 90;
export const MS_POR_DIA = 86_400_000;

export interface JanelaIso {
  from: string;
  to: string;
}

/** undefined aguarda a janela do servidor; null usa o padrão da própria rota. */
export type JanelaDeMetricas = JanelaIso | null | undefined;

export interface DiasDoPeriodo {
  de: string;
  ate: string;
}

type Resultado =
  | { janela: JanelaIso }
  | { erro: "incompleto" | "data" | "ordem" | "limite" | "fuso" };

function diaEmUtc(data: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) return NaN;
  const instante = new Date(`${data}T00:00:00Z`);
  return Number.isFinite(instante.getTime()) && instante.toISOString().slice(0, 10) === data
    ? instante.getTime()
    : NaN;
}

function diaNoFuso(instante: number, fuso: string): string {
  const { ano, mes, dia } = partesNoFuso(new Date(instante), fuso);
  return `${String(ano).padStart(4, "0")}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
}

/** Primeiro instante no dia pedido ou, se o fuso pulou a data toda, no dia seguinte. */
function limiteDoDia(alvo: number, fuso: string) {
  const dia = new Date(alvo).toISOString().slice(0, 10);
  // Os offsets dos dois lados também encontram a primeira de duas meias-noites.
  const antes = alvo - offsetEmMinutos(new Date(alvo - MS_POR_DIA), fuso) * 60_000;
  const depois = alvo - offsetEmMinutos(new Date(alvo + MS_POR_DIA), fuso) * 60_000;
  let inicio = Math.min(antes, depois);
  let fim = Math.max(antes, depois);

  if (diaNoFuso(inicio, fuso) === dia) {
    // Ex.: St. John's às 00:01 voltava para 23:01 da véspera. Uma única
    // janela com esta borda misturaria os dias em vez de recortar o calendário.
    const descontinuo = inicio !== fim && diaNoFuso(fim - 1, fuso) < dia;
    return { instante: inicio, existe: true, descontinuo };
  }

  // Virada para a frente. Procura a transição em vez de somar uma hora ao
  // relógio: há saltos de duração diferente e dias inteiros que não existiram.
  while (fim - inicio > 1) {
    const meio = Math.floor((inicio + fim) / 2);
    if (diaNoFuso(meio, fuso) < dia) inicio = meio;
    else fim = meio;
  }
  return { instante: fim, existe: diaNoFuso(fim, fuso) === dia, descontinuo: false };
}

export function diasDoPeriodo({ de, ate }: DiasDoPeriodo): number {
  return (diaEmUtc(ate) - diaEmUtc(de)) / MS_POR_DIA + 1;
}

export function datasDaJanela({ from, to }: { from: Date; to: Date }, fuso: string): DiasDoPeriodo {
  return { de: diaNoFuso(from.getTime(), fuso), ate: diaNoFuso(to.getTime() - 1, fuso) };
}

/** Entradas civis inclusivas, consultas em instantes semiabertos [from, to). */
export function janelaDoDesempenho({ de, ate }: DiasDoPeriodo, fuso: string): Resultado {
  if (!de || !ate) return { erro: "incompleto" };
  const inicioCivil = diaEmUtc(de);
  const fimCivil = diaEmUtc(ate);
  if (!Number.isFinite(inicioCivil) || !Number.isFinite(fimCivil)) return { erro: "data" };
  if (inicioCivil > fimCivil) return { erro: "ordem" };
  if (diasDoPeriodo({ de, ate }) > MAXIMO_DE_DIAS) return { erro: "limite" };

  const inicio = limiteDoDia(inicioCivil, fuso);
  const ultimoDia = inicioCivil === fimCivil ? inicio : limiteDoDia(fimCivil, fuso);
  const fim = limiteDoDia(fimCivil + MS_POR_DIA, fuso);
  if (!inicio.existe || !ultimoDia.existe || inicio.descontinuo || fim.descontinuo) {
    return { erro: "fuso" };
  }

  return {
    janela: {
      from: new Date(inicio.instante).toISOString(),
      to: new Date(fim.instante).toISOString(),
    },
  };
}

export function parametrosDaJanela(janela?: JanelaIso | null): URLSearchParams {
  return new URLSearchParams(janela ? { from: janela.from, to: janela.to } : {});
}
